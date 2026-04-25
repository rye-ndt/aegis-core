import "dotenv/config";
import { createLogger } from "./helpers/observability/logger";

const log = createLogger("entrypoint");

process.env.HTTP_API_PORT ??= process.env.PORT ?? "8080";

const role = (process.env.PROCESS_ROLE ?? "combined").toLowerCase();

async function main(): Promise<void> {
  log.info({ step: "started", role }, "boot sequence begin");

  const start = Date.now();
  await import("./migrate");
  log.info({ step: "submitted", durationMs: Date.now() - start }, "migrations applied");

  switch (role) {
    case "worker":
      log.info({ step: "succeeded", target: "workerCli" }, "dispatching role");
      await import("./workerCli");
      return;
    case "http":
      log.info({ step: "succeeded", target: "httpCli" }, "dispatching role");
      await import("./httpCli");
      return;
    case "combined":
      log.info({ step: "succeeded", target: "telegramCli" }, "dispatching role");
      await import("./telegramCli");
      return;
    default:
      log.error({ step: "failed", role }, "unknown PROCESS_ROLE");
      process.exit(1);
  }
}

main().catch((err) => {
  log.error({ err }, "boot failed");
  process.exit(1);
});
