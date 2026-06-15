import type { Server } from "node:http";
import { createMcpExpressApp } from "./app";
import Logger from "./utils/logger";

const rawPort = process.env.PORT || "8080";
const port = Number.parseInt(rawPort, 10);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid PORT value: ${rawPort}`);
}

const app = createMcpExpressApp();

const server: Server = app.listen(port, () => {
  Logger.info("Standalone MCP server started", {
    operation: "server.started",
    port
  });
});

const shutdown = (signal: string) => {
  Logger.info("Shutdown signal received", {
    operation: "server.shutdown_signal",
    signal
  });
  server.close((error?: Error) => {
    if (error) {
      Logger.error("Server shutdown failed", {
        operation: "server.shutdown_failed"
      }, error);
      process.exitCode = 1;
    }
    process.exit();
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
