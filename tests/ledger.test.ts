import { randomUUID } from "node:crypto";
import request from "supertest";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createApp } from "../src/app";
import { createPool, migrate } from "../src/db";
import { ensureFundingAccount, reconcile } from "../src/ledger";

// Runs against a REAL MySQL/MariaDB database (no mocks), because the
// guarantees under test come from the database's locking and constraints.
const TEST_DB_URL = process.env.TEST_DATABASE_URL || "mysql://ledger:ledgerpass@127.0.0.1:3306/ledger_test";

let db: Pool;
let app: ReturnType<typeof createApp>;
let funding: number;

async function resetDb() {
  await db.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of ["postings", "journal_entries", "idempotency_keys", "outbox", "accounts"]) await db.query(`TRUNCATE TABLE ${t}`);
  await db.query("SET FOREIGN_KEY_CHECKS = 1");
  funding = await ensureFundingAccount(db);
  app = createApp(db, funding);
}

async function account(name: string, depositPaise = 0): Promise<number> {
  const res = await request(app).post("/api/accounts").send({ name });
  const id = res.body.account.id;
  if (depositPaise > 0) {
    await request(app).post("/api/deposits").set("Idempotency-Key", randomUUID()).send({ accountId: id, amount: depositPaise }).expect(201);
  }
  return id;
}

const balance = async (id: number) => (await request(app).get(`/api/accounts/${id}`)).body.account.balance as number;
const transfer = (from: number, to: number, amount: number, key = randomUUID()) =>
  request(app).post("/api/transfers").set("Idempotency-Key", key).send({ fromAccountId: from, toAccountId: to, amount });

beforeAll(async () => {
  db = createPool(TEST_DB_URL);
  await migrate(db);
});
afterAll(async () => db.end());
beforeEach(resetDb);

describe("transfers", () => {
  it("moves money with a balanced double-entry journal entry", async () => {
    const a = await account("A", 10_000);
    const b = await account("B");
    const res = await transfer(a, b, 2_500).expect(201);
    expect(res.body.entry.postings).toEqual([
      { accountId: a, amount: -2_500 },
      { accountId: b, amount: 2_500 },
    ]);
    expect(await balance(a)).toBe(7_500);
    expect(await balance(b)).toBe(2_500);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it("rejects overdrafts and moves nothing", async () => {
    const a = await account("A", 1_000);
    const b = await account("B");
    const res = await transfer(a, b, 1_001).expect(422);
    expect(res.body.error).toBe("insufficient_funds");
    expect(await balance(a)).toBe(1_000);
    expect(await balance(b)).toBe(0);
  });

  it("validates input before touching the database", async () => {
    const a = await account("A", 1_000);
    const b = await account("B");
    await transfer(a, b, 10.5).expect(400); // fractional paise
    await transfer(a, b, -5).expect(400);
    await transfer(a, a, 5).expect(400);
    await transfer(a, funding, 5).expect(400);
    await request(app).post("/api/transfers").send({ fromAccountId: a, toAccountId: b, amount: 5 }).expect(400); // no key
  });
});

describe("idempotency", () => {
  it("replays the original response for a retried request and moves money once", async () => {
    const a = await account("A", 10_000);
    const b = await account("B");
    const key = randomUUID();
    const first = await transfer(a, b, 1_000, key).expect(201);
    const second = await transfer(a, b, 1_000, key).expect(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await balance(a)).toBe(9_000);
  });

  it("rejects reuse of a key with a different request body", async () => {
    const a = await account("A", 10_000);
    const b = await account("B");
    const key = randomUUID();
    await transfer(a, b, 1_000, key).expect(201);
    const res = await transfer(a, b, 2_000, key).expect(422);
    expect(res.body.error).toBe("idempotency_key_reused");
    expect(await balance(a)).toBe(9_000);
  });

  it("stores business failures too, so a retry cannot succeed later by accident", async () => {
    const a = await account("A", 500);
    const b = await account("B");
    const key = randomUUID();
    await transfer(a, b, 1_000, key).expect(422);
    await request(app).post("/api/deposits").set("Idempotency-Key", randomUUID()).send({ accountId: a, amount: 5_000 }).expect(201);
    const retry = await transfer(a, b, 1_000, key).expect(422);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await balance(b)).toBe(0);
  });

  it("retry storm: 50 concurrent requests with one key create exactly one entry", async () => {
    const a = await account("A", 10_000);
    const b = await account("B");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => transfer(a, b, 100, key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.entry.id)).size).toBe(1);
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(49);
    expect(await balance(a)).toBe(9_900);
    expect(await balance(b)).toBe(100);
  });
});

describe("concurrency", () => {
  it("race: 200 parallel ₹1 withdrawals from a ₹100 account succeed exactly 100 times", async () => {
    const a = await account("A", 10_000); // ₹100
    const b = await account("B");
    const results = await Promise.all(Array.from({ length: 200 }, () => transfer(a, b, 100)));
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 422 && r.body.error === "insufficient_funds").length;
    expect(ok).toBe(100);
    expect(rejected).toBe(100);
    expect(await balance(a)).toBe(0);
    expect(await balance(b)).toBe(10_000);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it("opposite-direction transfers between the same accounts do not deadlock or lose money", async () => {
    const a = await account("A", 100_000);
    const b = await account("B", 100_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? transfer(a, b, 100) : transfer(b, a, 100))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await balance(a)) + (await balance(b))).toBe(200_000);
    expect((await reconcile(db)).ok).toBe(true);
  });
});

describe("reversals", () => {
  it("reverses an entry once with an opposite entry, never by deleting", async () => {
    const a = await account("A", 10_000);
    const b = await account("B");
    const t = await transfer(a, b, 3_000).expect(201);
    const id = t.body.entry.id;
    await request(app).post(`/api/entries/${id}/reverse`).set("Idempotency-Key", randomUUID()).expect(201);
    expect(await balance(a)).toBe(10_000);
    expect(await balance(b)).toBe(0);
    const again = await request(app).post(`/api/entries/${id}/reverse`).set("Idempotency-Key", randomUUID()).expect(409);
    expect(again.body.error).toBe("already_reversed");
    const [[{ n }]] = (await db.query("SELECT COUNT(*) AS n FROM journal_entries")) as any;
    expect(n).toBe(3); // deposit + transfer + reversal; nothing was deleted
    expect((await reconcile(db)).ok).toBe(true);
  });
});

describe("invariants (property-based)", () => {
  it("random concurrent batches of transfers keep every account non-negative and the ledger reconciled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ from: fc.integer({ min: 0, max: 4 }), to: fc.integer({ min: 0, max: 4 }), amount: fc.integer({ min: 1, max: 5_000 }) }),
          { minLength: 1, maxLength: 40 },
        ),
        async (ops) => {
          await resetDb();
          const ids = [];
          for (let i = 0; i < 5; i++) ids.push(await account(`P${i}`, 10_000));
          await Promise.all(ops.filter((o) => o.from !== o.to).map((o) => transfer(ids[o.from], ids[o.to], o.amount)));
          const balances = await Promise.all(ids.map(balance));
          expect(balances.every((x) => x >= 0)).toBe(true);
          expect(balances.reduce((s, x) => s + x, 0)).toBe(50_000);
          const report = await reconcile(db);
          expect(report.ok).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
