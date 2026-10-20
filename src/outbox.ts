import type { Pool, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "./db";

/**
 * Polls the outbox table and publishes events, then marks them published.
 * Delivery is at-least-once: if the process dies after publishing but before
 * the UPDATE commits, the event is sent again, so consumers must tolerate
 * duplicates (the dashboard dedupes by entry id).
 * SKIP LOCKED lets several server instances drain the outbox without
 * publishing the same row twice concurrently.
 */
export function startOutboxWorker(db: Pool, publish: (type: string, payload: unknown) => void, intervalMs = 300) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      await withTransaction(db, async (c) => {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT id, event_type, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
        );
        for (const r of rows) publish(r.event_type, JSON.parse(r.payload));
        if (rows.length) {
          await c.query("UPDATE outbox SET published_at = CURRENT_TIMESTAMP(3) WHERE id IN (?)", [rows.map((r) => r.id)]);
        }
      });
    } catch (err) {
      console.error("outbox worker error", err);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
