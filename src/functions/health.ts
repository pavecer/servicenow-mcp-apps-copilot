import { app, HttpResponseInit } from "@azure/functions";
import { withFunctionContext } from "./wrap";

/**
 * Health / readiness probe for the Azure Functions deployment.
 *
 * The standalone Express app (src/app.ts) registers its own /health route,
 * but in the Functions host only routes registered via `app.http(...)` are
 * exposed — so we publish an explicit Functions binding here as well.
 *
 * Anonymous on purpose: this is a liveness signal for monitors and the
 * platform; it returns no sensitive data.
 */
app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: withFunctionContext(async (): Promise<HttpResponseInit> => ({
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ status: "ok", server: "servicenow-mcp" })
  }))
});
