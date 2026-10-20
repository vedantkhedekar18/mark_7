import crypto from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { withTransaction } from "./db";

/** Result of a money-moving operation: an HTTP status and a JSON body. */
export interface OpResult {
  status: number;
  body: Record<string, unknown>;
  replayed?: boolean;
}

export const MAX_AMOUNT = 1_000_000_000_00; // ₹1,000,000,000 in paise
const MAX_RETRIES = 5;

// MySQL/MariaDB error numbers we treat as safe to retry.
const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;
const ER_LOCK_WAIT_TIMEOUT = 1205;

class ReplaySignal extends Error {}

export interface LedgerStats {
  retries: number;
}
export const stats: LedgerStats = { retries: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hashRequest(op: string, fields: Record<string, unknown>): string {
  const canonical = JSON.stringify([op, ...Object.keys(fields).sort().map((k) => [k, fields[k]])]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Runs `work` exactly once per idempotency key.
 *
 * The key row is inserted in the SAME transaction as the money movement, so
 * either both commit or neither does. A concurrent request with the same key
 * blocks on the key's unique index until the first transaction finishes, then
 * gets a duplicate-key error and replays the stored response instead of moving
 * money again. Deadlocks and lock-wait timeouts roll everything back (key
 * included) and are retried with jittered backoff.
 */
export async function runIdempotent(
  db: Pool,
  key: string,
  requestHash: string,
  work: (c: PoolConnection) => Promise<OpResult>,
): Promise<OpResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, async (c) => {
        try {
          await c.query(
            "INSERT INTO idempotency_keys (idem_key, request_hash, response_code, response_body) VALUES (?, ?, 0, '')",
            [key, requestHash],
          );
        } catch (e: any) {
          if (e?.errno === ER_DUP_ENTRY) throw new ReplaySignal();
          throw e;
        }
        const result = await work(c);
        await c.query("UPDATE idempotency_keys SET response_code = ?, response_body = ? WHERE idem_key = ?", [
          result.status,
          JSON.stringify(result.body),
          key,
        ]);
        return result;
      });
    } catch (e: any) {
      if (e instanceof ReplaySignal) return replay(db, key, requestHash);
      const retryable = e?.errno === ER_LOCK_DEADLOCK || e?.errno === ER_LOCK_WAIT_TIMEOUT;
      if (retryable && attempt < MAX_RETRIES) {
        stats.retries++;
        await sleep(5 * 2 ** attempt + Math.random() * 10);
        continue;
      }
      throw e;
    }
  }
}

async function replay(db: Pool, key: string, requestHash: string): Promise<OpResult> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE idem_key = ?",
    [key],
  );
  const row = rows[0];
  if (!row) throw new Error("idempotency key vanished during replay");
  if (row.request_hash !== requestHash) {
    return {
      status: 422,
      body: { error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different request." },
    };
  }
  return { status: row.response_code, body: JSON.parse(row.response_body), replayed: true };
}

interface LockedAccount {
  id: number;
  balance: number;
  currency: string;
  allow_negative: number;
}

/** Locks accounts in ascending id order so two transfers can never wait on each other in a cycle. */
async function lockAccounts(c: PoolConnection, ids: number[]): Promise<Map<number, LockedAccount>> {
  const locked = new Map<number, LockedAccount>();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT id, balance, currency, allow_negative FROM accounts WHERE id = ? FOR UPDATE",
      [id],
    );
    if (rows[0]) locked.set(id, rows[0] as LockedAccount);
  }
  return locked;
}

/** Writes a balanced journal entry plus its outbox event. Caller must hold locks on every account. */
async function writeEntry(
  c: PoolConnection,
  kind: "deposit" | "transfer" | "reversal",
  description: string | null,
  lines: { accountId: number; amount: number }[],
  reversesEntryId: number | null = null,
) {
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error("unbalanced entry"); // programming error, never a user error

  const [res] = await c.query<ResultSetHeader>(
    "INSERT INTO journal_entries (kind, description, reverses_entry_id) VALUES (?, ?, ?)",
    [kind, description, reversesEntryId],
  );
  const entryId = res.insertId;
  for (const l of lines) {
    await c.query("INSERT INTO postings (entry_id, account_id, amount) VALUES (?, ?, ?)", [entryId, l.accountId, l.amount]);
    await c.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [l.amount, l.accountId]);
  }
  const entry = { id: entryId, kind, description, reversesEntryId, postings: lines };
  await c.query("INSERT INTO outbox (event_type, payload) VALUES (?, ?)", [`entry.${kind}`, JSON.stringify(entry)]);
  return entry;
}

export interface TransferInput {
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  description?: string | null;
}

export function transferWork(input: TransferInput, kind: "deposit" | "transfer" = "transfer") {
  return async (c: PoolConnection): Promise<OpResult> => {
    const { fromAccountId, toAccountId, amount } = input;
    const accounts = await lockAccounts(c, [fromAccountId, toAccountId]);
    const from = accounts.get(fromAccountId);
    const to = accounts.get(toAccountId);
    if (!from || !to) {
      return { status: 404, body: { error: "account_not_found", accountId: !from ? fromAccountId : toAccountId } };
    }
    if (from.currency !== to.currency) {
      return { status: 422, body: { error: "currency_mismatch" } };
    }
    // Checked while holding the row lock, so no concurrent transfer can spend the same money.
    if (!from.allow_negative && from.balance - amount < 0) {
      return { status: 422, body: { error: "insufficient_funds", available: from.balance, requested: amount } };
    }
    const entry = await writeEntry(c, kind, input.description ?? null, [
      { accountId: fromAccountId, amount: -amount },
      { accountId: toAccountId, amount },
    ]);
    return { status: 201, body: { entry } };
  };
}

export function reversalWork(entryId: number) {
  return async (c: PoolConnection): Promise<OpResult> => {
    // Locking the original entry serializes concurrent reversal attempts of the same entry.
    const [entries] = await c.query<RowDataPacket[]>(
      "SELECT id, kind FROM journal_entries WHERE id = ? FOR UPDATE",
      [entryId],
    );
    const original = entries[0];
    if (!original) return { status: 404, body: { error: "entry_not_found" } };
    if (original.kind === "reversal") return { status: 422, body: { error: "cannot_reverse_a_reversal" } };

    const [already] = await c.query<RowDataPacket[]>("SELECT id FROM journal_entries WHERE reverses_entry_id = ?", [entryId]);
    if (already[0]) return { status: 409, body: { error: "already_reversed", reversalEntryId: already[0].id } };

    const [postings] = await c.query<RowDataPacket[]>("SELECT account_id, amount FROM postings WHERE entry_id = ?", [entryId]);
    const lines = postings.map((p) => ({ accountId: p.account_id as number, amount: -(p.amount as number) }));
    const accounts = await lockAccounts(c, lines.map((l) => l.accountId));
    for (const l of lines) {
      const a = accounts.get(l.accountId)!;
      if (!a.allow_negative && a.balance + l.amount < 0) {
        return { status: 422, body: { error: "insufficient_funds_for_reversal", accountId: a.id } };
      }
    }
    const entry = await writeEntry(c, "reversal", `Reversal of entry ${entryId}`, lines, entryId);
    return { status: 201, body: { entry } };
  };
}

/** Finds (or creates once) the system account that represents money entering the ledger. */
export async function ensureFundingAccount(db: Pool): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM accounts WHERE allow_negative = TRUE ORDER BY id LIMIT 1");
  if (rows[0]) return rows[0].id;
  const [res] = await db.query<ResultSetHeader>(
    "INSERT INTO accounts (name, allow_negative) VALUES ('External Funding (system)', TRUE)",
  );
  return res.insertId;
}

export interface ReconciliationReport {
  ok: boolean;
  accountsChecked: number;
  entriesChecked: number;
  balanceMismatches: { accountId: number; cachedBalance: number; postingsSum: number }[];
  unbalancedEntries: { entryId: number; sum: number; lines: number }[];
  totalOfAllBalances: number;
  checkedAt: string;
}

/**
 * Proves three invariants from first principles:
 *  1. every cached balance equals the sum of that account's postings,
 *  2. every journal entry has >= 2 postings that sum to zero,
 *  3. all balances (including the funding account) sum to zero.
 */
export async function reconcile(db: Pool): Promise<ReconciliationReport> {
  const [mismatch] = await db.query<RowDataPacket[]>(`
    SELECT a.id AS accountId, a.balance AS cachedBalance, COALESCE(SUM(p.amount), 0) AS postingsSum
    FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(p.amount), 0)`);
  const [unbalanced] = await db.query<RowDataPacket[]>(`
    SELECT e.id AS entryId, COALESCE(SUM(p.amount), 0) AS entrySum, COUNT(p.id) AS lineCount
    FROM journal_entries e LEFT JOIN postings p ON p.entry_id = e.id
    GROUP BY e.id
    HAVING COALESCE(SUM(p.amount), 0) <> 0 OR COUNT(p.id) < 2`);
  const [[counts]] = await db.query<RowDataPacket[]>(`
    SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
           (SELECT COUNT(*) FROM journal_entries) AS entries,
           (SELECT COALESCE(SUM(balance), 0) FROM accounts) AS total`);
  const total = Number(counts.total);
  return {
    ok: mismatch.length === 0 && unbalanced.length === 0 && total === 0,
    accountsChecked: Number(counts.accounts),
    entriesChecked: Number(counts.entries),
    balanceMismatches: mismatch.map((r) => ({ accountId: r.accountId, cachedBalance: Number(r.cachedBalance), postingsSum: Number(r.postingsSum) })),
    unbalancedEntries: unbalanced.map((r) => ({ entryId: r.entryId, sum: Number(r.entrySum), lines: Number(r.lineCount) })),
    totalOfAllBalances: total,
    checkedAt: new Date().toISOString(),
  };
}
