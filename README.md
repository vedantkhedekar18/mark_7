# Transfer Ledger

A double-entry money-transfer service that cannot double-charge, overdraw, or silently lose money, even under retries and heavy concurrency.

**Stack:** Node.js, TypeScript, Express, MySQL (InnoDB), Socket.io, Vitest, fast-check.

## What it guarantees, and how

| Guarantee | Mechanism | Proven by |
|---|---|---|
| Every transfer is balanced | Double-entry: each journal entry writes postings that sum to zero; a non-zero sum throws before anything is written | Reconciliation check in every test |
| No overdrafts under concurrency | Balance check happens *after* `SELECT … FOR UPDATE` row locks, inside the same transaction | Race test: 200 parallel ₹1 withdrawals from ₹100 → exactly 100 succeed, balance ends at ₹0 |
| No deadlock cycles | Accounts are always locked in ascending id order; deadlocks/lock-wait timeouts that still occur are retried with jittered exponential backoff | Opposite-direction test: 100 concurrent A→B and B→A transfers all succeed |
| A retried request never moves money twice | `Idempotency-Key` row inserted in the same transaction as the money movement; a concurrent duplicate blocks on the unique index, then replays the stored response | Retry storm: 50 concurrent requests with one key → 1 entry, 49 replays |
| A key can't be reused for a different request | SHA-256 hash of the canonical request stored with the key | Key-reuse test → `422 idempotency_key_reused` |
| History is never rewritten | Append-only journal; mistakes are fixed with reversal entries (`UNIQUE(reverses_entry_id)` prevents double reversal) | Reversal test |
| Cached balances are trustworthy | Reconciliation recomputes every balance from postings, checks every entry sums to zero, and checks all balances sum to zero | `GET /api/reconciliation`, and property-based test over 50 random concurrent batches |
| UI never shows an uncommitted transfer | Transactional outbox written in the same transaction; a worker publishes via Socket.io (at-least-once, `SKIP LOCKED`) | Manual: live journal on the dashboard |

Money is stored as integer **paise** (`BIGINT`), never floating point. Deposits come from a system "External Funding" account, which is the only account allowed to go negative, so the sum of all balances is always exactly zero.

## Benchmark

`npm run bench -- 5000 50 100`: 5,000 transfers between random pairs of 100 accounts, 50 in flight at once.

| Throughput | p50 | p95 | p99 | Outcomes | Deadlock retries | Reconciles |
|---|---|---|---|---|---|---|
| 544 req/s | 87.9 ms | 136.6 ms | 177.2 ms | 5,000 × 201 | 0 | ✓ |

Measured on 2 vCPU / 8 GB RAM Linux, with the app and MariaDB 10.11 on the same host. Treat these as a baseline for this machine, not a production claim.

## Testing the tests

Removing the `FOR UPDATE` row lock makes the race test fail (69 successes instead of 100), which shows that the test detects lost updates rather than passing by luck.

## API

All money-moving `POST`s require an `Idempotency-Key` header. Replays carry `Idempotent-Replayed: true`.

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/accounts` | `{ "name": "Asha" }` |
| `GET` | `/api/accounts`, `/api/accounts/:id` | |
| `POST` | `/api/deposits` | `{ "accountId": 2, "amount": 50000 }` |
| `POST` | `/api/transfers` | `{ "fromAccountId": 2, "toAccountId": 3, "amount": 1200, "description": "rent" }` |
| `POST` | `/api/entries/:id/reverse` | |
| `GET` | `/api/entries?limit=25` | |
| `GET` | `/api/reconciliation` | |

Status codes: `201` success, `400` invalid request (not stored against the key), `404` unknown account, `409` already reversed, `422` insufficient funds / key reused. Business outcomes (`404`, `409`, `422`) are stored against the key, so a retry can't succeed later by accident.

## Run locally

```bash
npm install
export DATABASE_URL=mysql://user:pass@127.0.0.1:3306/ledger
npm run dev            # http://localhost:3000 (schema is created on startup)
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/ledger_test npm test
```

Tests run against a real MySQL database, not mocks, because the guarantees come from InnoDB locking and constraints.

## Deploy (Render + hosted MySQL)

1. Create a MySQL database (for example an Aiven free MySQL service) and copy its connection URI and CA certificate.
2. On Render: **New → Blueprint**, pick this repo (it reads `render.yaml`), then set `DATABASE_URL` and `DB_CA_CERT`.
3. The schema is created automatically on first start.

## Design notes and known limits

- **Isolation level:** `READ COMMITTED` with explicit row locks. It avoids InnoDB gap locks (fewer deadlocks) while the `FOR UPDATE` locks give the serialization that matters. `SERIALIZABLE` would also be correct but locks more than needed.
- **Hot accounts:** one very busy account serializes all of its transfers on a single row lock. Real systems shard or buffer hot accounts; this one doesn't.
- **Single currency:** INR only. Cross-currency checks exist, but no FX.
- **No auth:** this is a ledger-correctness demo, not a user-facing bank. Authentication would sit in front of these routes.
- **Idempotency keys are never pruned.** Production systems expire them (e.g. after 24h).
