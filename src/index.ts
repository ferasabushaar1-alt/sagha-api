import "dotenv/config";
import { createApp } from "./app.js";
import { initDatabase } from "./db/init.js";
import { startStockReservationTtlJob } from "./jobs/stock-ttl.js";
import { assertCloudEnv } from "./lib/runtime-env.js";

async function main() {
  assertCloudEnv();
  await initDatabase();

  const port = Number(process.env.PORT ?? 4000);
  const app = createApp();

  startStockReservationTtlJob();

  app.listen(port, "0.0.0.0", () => {
    console.log(`Sagha API listening on http://0.0.0.0:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
  });
}

main().catch((err) => {
  console.error("Failed to start API:", err);
  process.exit(1);
});
