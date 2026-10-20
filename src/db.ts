import fs from "node:fs";
import path from "node:path";
import mysql, { Pool, PoolConnection } from "mysql2/promise";

export type Db = Pool;

/**
 * Creates a connection pool from DATABASE_URL, e.g.
 *   mysql://user:pass@host:3306/ledger
 * Set DB_SSL=true for hosted databases that require TLS.
 */
export function createPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  const u = new URL(url);
  return mysql.createPool({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectionLimit: Number(process.env.DB_POOL_SIZE || 20),
    supportBigNumbers: true, // BIGINT -> number when safe
    decimalNumbers: true,    // SUM() -> number instead of string
    multipleStatements: false,
    // Hosted MySQL (e.g. Aiven) needs TLS; DB_CA_CERT holds the provider's CA certificate (PEM text).
    ssl: process.env.DB_SSL === "true"
      ? { rejectUnauthorized: true, ca: process.env.DB_CA_CERT?.replace(/\\n/g, "\n") }
      : undefined,
  });
}

/** Applies schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so it is safe to re-run. */
export async function migrate(db: Pool): Promise<void> {
  const file = [path.join(__dirname, "schema.sql"), path.join(__dirname, "..", "src", "schema.sql")]
    .find((f) => fs.existsSync(f));
  if (!file) throw new Error("schema.sql not found");
  const statements = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) await db.query(s);
}

/** Runs fn inside a transaction on a dedicated connection. */
export async function withTransaction<T>(db: Pool, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
