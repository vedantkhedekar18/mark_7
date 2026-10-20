import http from "node:http";
import type { RequestListener } from "node:http";
import { Server as SocketServer } from "socket.io";
import { createApp } from "./app";
import { createPool, migrate } from "./db";
import { ensureFundingAccount } from "./ledger";
import { startOutboxWorker } from "./outbox";

/**
 * The HTTP server is created synchronously so it can be the default export
 * (Vercel Functions expect that). Requests wait until the database pool,
 * schema and funding account are ready.
 */
const db = createPool();
let stopOutbox: (() => void) | undefined;

const ready: Promise<RequestListener> = (async () => {
  await migrate(db);
  const fundingAccountId = await ensureFundingAccount(db);
  return createApp(db, fundingAccountId) as unknown as RequestListener;
})();
ready.catch((err) => console.error("startup failed", err));

const server = http.createServer((req, res) => {
  ready.then((app) => app(req, res)).catch(() => {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "service_unavailable" }));
  });
});

const io = new SocketServer(server);
ready.then(() => {
  stopOutbox = startOutboxWorker(db, (type, payload) => io.emit("ledger-event", { type, payload }));
}).catch(() => undefined);

export default server;

// Long-running host (local, Render): listen on a port. On Vercel the platform does this.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Transfer Ledger listening on :${port}`));

  const shutdown = () => {
    stopOutbox?.();
    io.close();
    server.close(() => db.end().then(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
