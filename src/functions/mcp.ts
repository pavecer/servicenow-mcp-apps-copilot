import { app, HttpRequest } from "@azure/functions";
import serverlessHttp from "serverless-http";
import { createMcpExpressApp } from "../app";
import { withFunctionContext } from "./wrap";

/**
 * serverless-http's Azure provider calls `context.log(response)` on every
 * request, dumping the entire Node ServerResponse object into App Insights
 * `traces` (Category Function.servicenow-mcp.User). That single object is huge,
 * has no operational value, and drowns our structured Logger lines (plus it adds
 * ingestion cost). This proxy drops `log()` calls whose only argument is an
 * object (the ServerResponse dump) while forwarding string logs and every other
 * context member (including info/warn/error/debug used by our Logger sink)
 * untouched.
 *
 * Exported for unit testing.
 */
export function createQuietContext<T extends { log: (...args: unknown[]) => void }>(context: T): T {
  return new Proxy(context, {
    get(target, prop) {
      if (prop === "log") {
        const original = Reflect.get(target, prop) as (...args: unknown[]) => void;
        const quietLog = (...args: unknown[]): void => {
          if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
            return; // swallow serverless-http's ServerResponse dump
          }
          original.apply(target, args);
        };
        // Preserve the level methods hanging off context.log (log.info, etc.).
        return Object.assign(quietLog, original);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as T;
}

/**
 * Azure Functions v4 HTTP trigger that hosts the ServiceNow MCP server.
 *
 * The MCP endpoint is accessible at:
 *   https://<function-app>.azurewebsites.net/mcp
 *
 * Authentication: Azure Function key passed via header `x-functions-key`
 * or query parameter `code`.
 *
 */
const handler = serverlessHttp(createMcpExpressApp(), {
  provider: "azure"
});

async function toMutableAzureRequest(request: HttpRequest): Promise<Record<string, unknown>> {
  const requestUrl = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  const normalizedAccept = String(headers.accept || "");
  const acceptsJson = normalizedAccept.includes("application/json") || normalizedAccept.includes("*/*");
  const acceptsSse = normalizedAccept.includes("text/event-stream") || normalizedAccept.includes("*/*");

  if (!acceptsJson || !acceptsSse) {
    headers.accept = "application/json, text/event-stream";
  }

  const query = Object.fromEntries(requestUrl.searchParams.entries());

  return {
    method: request.method,
    url: requestUrl.pathname,
    requestPath: requestUrl.pathname,
    headers,
    query,
    // serverless-http azure provider expects rawBody for request creation.
    rawBody: await request.text()
  };
}

app.http("servicenow-mcp", {
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "mcp",
  // Azure Functions v4 passes (request, context), while serverless-http Azure provider expects (context, req).
  // withFunctionContext binds the per-invocation logging sink so Logger.* lands in App Insights `traces`.
  handler: withFunctionContext(async (request, context) => {
    const mutableReq = await toMutableAzureRequest(request);
    // Suppress serverless-http's per-request ServerResponse dump (see
    // createQuietContext). The Logger sink bound by withFunctionContext still
    // uses the real context, so structured traces are unaffected.
    return handler(createQuietContext(context), mutableReq);
  })
});
