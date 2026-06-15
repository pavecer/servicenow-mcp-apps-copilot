import { app, HttpRequest } from "@azure/functions";
import serverlessHttp from "serverless-http";
import { createMcpExpressApp } from "../app";
import { withFunctionContext } from "./wrap";

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
    return handler(context, mutableReq);
  })
});
