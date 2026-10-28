/**
 * Hard stock reservation TTL sweeper.
 * Pending orders deduct stock at place; this job cancels stale pending
 * reservations and returns inventory (see expireStalePendingOrders).
 */
import {
  expireStalePendingOrders,
  ORDER_PENDING_TTL_MS,
} from "../services/orders.service.js";

const DEFAULT_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.ORDER_PENDING_SWEEP_MS ?? 5 * 60 * 1000),
);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startStockReservationTtlJob(
  intervalMs: number = DEFAULT_INTERVAL_MS,
) {
  if (timer) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await expireStalePendingOrders(ORDER_PENDING_TTL_MS);
      if (result.expired > 0) {
        console.log(
          `[stock-ttl] expired ${result.expired} pending order(s) older than ${ORDER_PENDING_TTL_MS}ms`,
        );
      }
    } catch (err) {
      console.error(
        "[stock-ttl] sweep failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      running = false;
    }
  };

  // Run once shortly after boot, then on interval.
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log(
    `[stock-ttl] reservation sweeper every ${intervalMs}ms (pending TTL ${ORDER_PENDING_TTL_MS}ms)`,
  );
}

export function stopStockReservationTtlJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
