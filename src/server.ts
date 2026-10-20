import http from "node:http";
import { Server as SocketServer } from "socket.io";
import { createApp } from "./app";
import { createPool, migrate } from "./db";
import { ensureFundingAccount } from "./ledger";
import { startOutboxWorker } from "./outbox";

async function main() {
  const db = createPool();
  await migrate(db);
  const fundingAccountId = await ensureFundingAccount(db);

  const app = createApp(db, fundingAccountId);
  const server = http.createServer(app);
  const io = new SocketServer(server);
  const stopOutbox = startOutboxWorker(db, (type, payload) => io.emit("ledger-event", { type, payload }));

  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Transfer Ledger listening on :${port}`));

  const shutdown = () => {
    stopOutbox();
    io.close();
    server.close(() => db.end().then(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
