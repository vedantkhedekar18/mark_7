/**
 * Load benchmark: N transfers between random pairs of accounts, C in flight at once.
 *   DATABASE_URL=mysql://... npm run bench -- [totalRequests] [concurrency] [accounts]
 * Reports throughput, latency percentiles, outcome counts and a reconciliation check.
 * WARNING: wipes the target database. Point it at a scratch database only.
 */
import http from "node:http";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { createPool, migrate } from "../src/db";
import { ensureFundingAccount, reconcile, stats } from "../src/ledger";

const [total = 5000, concurrency = 50, accountCount = 100] = process.argv.slice(2).map(Number);

function post(port: number, path: string, body: unknown, key: string): Promise<number> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", agent,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "Idempotency-Key": key } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });

async function main() {
  const db = createPool();
  await migrate(db);
  await db.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of ["postings", "journal_entries", "idempotency_keys", "outbox", "accounts"]) await db.query(`TRUNCATE TABLE ${t}`);
  await db.query("SET FOREIGN_KEY_CHECKS = 1");
  const funding = await ensureFundingAccount(db);
  const server = http.createServer(createApp(db, funding)).listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;

  const ids: number[] = [];
  for (let i = 0; i < accountCount; i++) {
    const [r]: any = await db.query("INSERT INTO accounts (name) VALUES (?)", [`bench-${i}`]);
    ids.push(r.insertId);
    await post(port, "/api/deposits", { accountId: r.insertId, amount: 1_000_000 }, randomUUID());
  }

  const latencies: number[] = [];
  const outcomes: Record<number, number> = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      next++;
      const from = ids[Math.floor(Math.random() * ids.length)];
      let to = from;
      while (to === from) to = ids[Math.floor(Math.random() * ids.length)];
      const s = performance.now();
      const code = await post(port, "/api/transfers", { fromAccountId: from, toAccountId: to, amount: 1 + Math.floor(Math.random() * 5000) }, randomUUID());
      latencies.push(performance.now() - s);
      outcomes[code] = (outcomes[code] || 0) + 1;
    }
  }));
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1);
  const report = await reconcile(db);

  console.log(JSON.stringify({
    requests: total, concurrency, accounts: accountCount,
    seconds: +elapsed.toFixed(2),
    throughputPerSec: Math.round(total / elapsed),
    latencyMs: { p50: +pct(50), p95: +pct(95), p99: +pct(99), max: +latencies[latencies.length - 1].toFixed(1) },
    outcomes, deadlockRetries: stats.retries,
    reconciliationOk: report.ok,
    machine: `${os.cpus().length} vCPU, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()}; app and DB on the same host`,
  }, null, 2));

  server.close();
  agent.destroy();
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
