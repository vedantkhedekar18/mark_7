/**
 * Runs the test suite once against each database in docker-compose.yml.
 *   docker compose up -d --wait
 *   npm run test:matrix                 # all databases
 *   npm run test:matrix -- mariadb118   # just one
 * Prints each server's version and snapshot-isolation setting, then a pass/fail summary.
 * Exits non-zero if any database fails.
 */
import { spawnSync } from "node:child_process";
import type { RowDataPacket } from "mysql2/promise";
import { createPool } from "../src/db";

const targets: Record<string, string> = {
  mysql80: "mysql://ledger:ledgerpass@127.0.0.1:3307/ledger_test",
  mariadb1011: "mysql://ledger:ledgerpass@127.0.0.1:3308/ledger_test",
  mariadb118: "mysql://ledger:ledgerpass@127.0.0.1:3309/ledger_test",
};

async function describeServer(url: string): Promise<string> {
  const db = createPool(url);
  try {
    // MariaDB before 11.1 names the isolation variable tx_isolation; MySQL 8 and newer MariaDB use transaction_isolation.
    const [rows] = await db.query<RowDataPacket[]>(
      "SHOW VARIABLES WHERE Variable_name IN ('version', 'transaction_isolation', 'tx_isolation', 'innodb_snapshot_isolation')",
    );
    const v = Object.fromEntries(rows.map((r) => [r.Variable_name, r.Value]));
    const iso = v.transaction_isolation ?? v.tx_isolation;
    return `${v.version}, server default isolation ${iso}, innodb_snapshot_isolation=${v.innodb_snapshot_isolation ?? "n/a"}`;
  } finally {
    await db.end();
  }
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(targets);
  const summary: string[] = [];
  let failed = false;

  for (const name of names) {
    const url = targets[name];
    if (!url) throw new Error(`unknown target ${name}; expected one of ${Object.keys(targets).join(", ")}`);
    let server: string;
    try {
      server = await describeServer(url);
    } catch (err: any) {
      summary.push(`${name}: NOT RUN (${err?.code ?? err?.message}). Is \`docker compose up -d --wait\` running?`);
      failed = true;
      continue;
    }
    console.log(`\n=== ${name}: ${server}`);
    const run = spawnSync("npx", ["vitest", "run"], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, TEST_DATABASE_URL: url },
    });
    const ok = run.status === 0;
    failed ||= !ok;
    summary.push(`${name}: ${ok ? "PASS" : "FAIL"} (${server})`);
  }

  console.log(`\n=== Summary\n${summary.join("\n")}`);
  process.exit(failed ? 1 : 0);
}

main();
