import express, { NextFunction, Request, Response } from "express";
import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import {
  MAX_AMOUNT,
  OpResult,
  hashRequest,
  reconcile,
  reversalWork,
  runIdempotent,
  transferWork,
} from "./ledger";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

class BadRequest extends Error {}

function positiveId(v: unknown, field: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new BadRequest(`${field} must be a positive integer`);
  return n;
}

function amountPaise(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > MAX_AMOUNT) {
    throw new BadRequest(`amount must be an integer number of paise between 1 and ${MAX_AMOUNT}`);
  }
  return v;
}

function idemKey(req: Request): string {
  const k = req.header("Idempotency-Key");
  if (!k || k.length > 255) throw new BadRequest("Idempotency-Key header is required (max 255 chars)");
  return k;
}

function description(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || v.length > 255) throw new BadRequest("description must be a string of at most 255 chars");
  return v;
}

function send(res: Response, r: OpResult) {
  if (r.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(r.status).json(r.body);
}

export function createApp(db: Pool, fundingAccountId: number) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", wrap(async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true });
  }));

  app.get("/api/accounts", wrap(async (_req, res) => {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT id, name, currency, balance, allow_negative AS isSystem, created_at AS createdAt FROM accounts ORDER BY id",
    );
    res.json({ accounts: rows.map((r) => ({ ...r, isSystem: !!r.isSystem })) });
  }));

  app.post("/api/accounts", wrap(async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new BadRequest("name is required (max 100 chars)");
    const [r] = await db.query<ResultSetHeader>("INSERT INTO accounts (name) VALUES (?)", [name.trim()]);
    res.status(201).json({ account: { id: r.insertId, name: name.trim(), currency: "INR", balance: 0 } });
  }));

  app.get("/api/accounts/:id", wrap(async (req, res) => {
    const id = positiveId(req.params.id, "id");
    const [acc] = await db.query<RowDataPacket[]>("SELECT id, name, currency, balance FROM accounts WHERE id = ?", [id]);
    if (!acc[0]) return res.status(404).json({ error: "account_not_found" });
    const [lines] = await db.query<RowDataPacket[]>(
      `SELECT p.entry_id AS entryId, p.amount, e.kind, e.description, e.created_at AS createdAt
       FROM postings p JOIN journal_entries e ON e.id = p.entry_id
       WHERE p.account_id = ? ORDER BY p.id DESC LIMIT 50`,
      [id],
    );
    res.json({ account: acc[0], recentPostings: lines });
  }));

  // Money in from outside the ledger: a transfer from the system funding account.
  app.post("/api/deposits", wrap(async (req, res) => {
    const key = idemKey(req);
    const toAccountId = positiveId(req.body?.accountId, "accountId");
    const amount = amountPaise(req.body?.amount);
    const hash = hashRequest("deposit", { toAccountId, amount });
    const input = { fromAccountId: fundingAccountId, toAccountId, amount, description: "Deposit" };
    send(res, await runIdempotent(db, key, hash, transferWork(input, "deposit")));
  }));

  app.post("/api/transfers", wrap(async (req, res) => {
    const key = idemKey(req);
    const fromAccountId = positiveId(req.body?.fromAccountId, "fromAccountId");
    const toAccountId = positiveId(req.body?.toAccountId, "toAccountId");
    if (fromAccountId === toAccountId) throw new BadRequest("fromAccountId and toAccountId must differ");
    if (fromAccountId === fundingAccountId || toAccountId === fundingAccountId) {
      throw new BadRequest("the system funding account can only be used through /api/deposits");
    }
    const amount = amountPaise(req.body?.amount);
    const desc = description(req.body?.description);
    const hash = hashRequest("transfer", { fromAccountId, toAccountId, amount, description: desc });
    send(res, await runIdempotent(db, key, hash, transferWork({ fromAccountId, toAccountId, amount, description: desc })));
  }));

  app.post("/api/entries/:id/reverse", wrap(async (req, res) => {
    const key = idemKey(req);
    const entryId = positiveId(req.params.id, "id");
    send(res, await runIdempotent(db, key, hashRequest("reverse", { entryId }), reversalWork(entryId)));
  }));

  app.get("/api/entries", wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const [entries] = await db.query<RowDataPacket[]>(
      "SELECT id, kind, description, reverses_entry_id AS reversesEntryId, created_at AS createdAt FROM journal_entries ORDER BY id DESC LIMIT ?",
      [limit],
    );
    const ids = entries.map((e) => e.id);
    const [postings] = ids.length
      ? await db.query<RowDataPacket[]>("SELECT entry_id AS entryId, account_id AS accountId, amount FROM postings WHERE entry_id IN (?) ORDER BY id", [ids])
      : [[] as RowDataPacket[]];
    res.json({
      entries: entries.map((e) => ({
        ...e,
        postings: postings.filter((p) => p.entryId === e.id).map((p) => ({ accountId: p.accountId, amount: p.amount })),
      })),
    });
  }));

  app.get("/api/reconciliation", wrap(async (_req, res) => {
    res.json(await reconcile(db));
  }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: "bad_request", message: err.message });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "bad_request", message: "invalid JSON" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
