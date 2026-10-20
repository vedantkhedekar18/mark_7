import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import type { Pool } from "mysql2/promise";
import { Server as SocketServer } from "socket.io";
import { createApp } from "./app";
import { createPool, migrate } from "./db";
import { ensureFundingAccount } from "./ledger";
import { startOutboxWorker } from "./outbox";

/**
 * Startup never crashes the process. The dashboard and /health are served
 * without a database; everything else waits for the database to be ready.
 * If setup fails (missing env var, unreachable DB, bad TLS cert), requests
 * get a 503 that says why, and the next request retries setup.
 * The HTTP server is created synchronously so it can be the default export,
 * which is what Vercel Functions expect.
 */
let ledgerApp: express.Express | undefined;
let pending: Promise<express.Express> | undefined;
let lastError: string | undefined;
let db: Pool | undefined;
let stopOutbox: (() => void) | undefined;

function describe(err: any): string {
  // Never echo DATABASE_URL or the certificate; error codes and messages are enough to debug.
  const code = err?.code ? `${err.code}: ` : "";
  return `${code}${err?.message ?? String(err)}`.slice(0, 300);
}

function getLedgerApp(): Promise<express.Express> {
  if (ledgerApp) return Promise.resolve(ledgerApp);
  if (!pending) {
    pending = (async () => {
      if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set on the server");
      db = db ?? createPool();
      await migrate(db);
      const fundingAccountId = await ensureFundingAccount(db);
      const app = createApp(db, fundingAccountId);
      stopOutbox = startOutboxWorker(db, (type, payload) => io.emit("ledger-event", { type, payload }));
      ledgerApp = app;
      lastError = undefined;
      return app;
    })().catch(async (err) => {
      lastError = describe(err);
      console.error("database setup failed:", lastError);
      pending = undefined; // retry on the next request
      if (db) await db.end().catch(() => undefined);
      db = undefined;
      throw err;
    });
  }
  return pending;
}

const front = express();

const publicDir = [path.join(__dirname, "..", "public"), path.join(process.cwd(), "public")].find((d) =>
  fs.existsSync(path.join(d, "index.html")),
);
if (publicDir) front.use(express.static(publicDir));

front.get("/health", async (_req, res) => {
  try {
    await getLedgerApp();
    await db!.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable", reason: lastError });
  }
});

front.use((req, res, next) => {
  getLedgerApp()
    .then((app) => app(req, res, next))
    .catch(() => res.status(503).json({ error: "database_unavailable", message: lastError }));
});

const server = http.createServer(front);
const io = new SocketServer(server);

export default server;

// Long-running host (local, Render): listen on a port. On Vercel the platform does this.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Transfer Ledger listening on :${port}`));
  getLedgerApp().catch(() => undefined); // warm up; failures are reported per request

  const shutdown = () => {
    stopOutbox?.();
    io.close();
    server.close(() => (db ? db.end() : Promise.resolve()).then(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
