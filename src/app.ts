import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMinimalToolDefinitions, registerTools } from "./tools/index";
import { runWithRequestContext } from "./requestContext";
import { config } from "./config";
import { entraAuthMiddleware } from "./utils/entraAuthMiddleware";
import { sharedServiceNowClient, sharedTokenManager } from "./services/instances";
import Logger from "./utils/logger";

const MCP_PATH = "/mcp";

/**
 * MCP JSON-RPC methods that perform real ServiceNow operations and therefore
 * require a valid per-user Entra token. Everything else (the discovery handshake
 * and widget-HTML resource fetch) is served anonymously so the Microsoft 365
 * Copilot / Cowork orchestrator and widget host can pre-flight the server before
 * the user signs in.
 */
const AUTH_REQUIRED_MCP_METHODS = new Set<string>(["tools/call"]);

/**
 * Returns true when a parsed MCP POST body contains at least one method that
 * requires authentication. Handles both single JSON-RPC requests and batches.
 */
function postBodyRequiresAuth(body: unknown): boolean {
  const requests = Array.isArray(body) ? body : [body];
  return requests.some(entry => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const method = (entry as { method?: unknown }).method;
    return typeof method === "string" && AUTH_REQUIRED_MCP_METHODS.has(method);
  });
}

/**
 * Extracts a concise, log-safe summary of the MCP method(s) and tool name(s) in
 * a POST body so the request-completion log line is traceable in Application
 * Insights (e.g. `tools/call:place_order`). Handles single and batch JSON-RPC.
 * Never includes tool arguments (they may carry PII / free text).
 */
function summarizeMcpBody(body: unknown): string {
  const requests = Array.isArray(body) ? body : [body];
  const parts: string[] = [];
  for (const entry of requests) {
    if (!entry || typeof entry !== "object") continue;
    const method = (entry as { method?: unknown }).method;
    if (typeof method !== "string") continue;
    if (method === "tools/call") {
      const name = (entry as { params?: { name?: unknown } }).params?.name;
      parts.push(typeof name === "string" ? `tools/call:${name}` : "tools/call");
    } else {
      parts.push(method);
    }
  }
  return parts.length > 0 ? parts.join(",") : "unknown";
}

/**
 * Creates and returns the Express application that hosts the MCP server.
 *
 * The MCP endpoint is exposed at any path (wildcard) to remain compatible with
 * both Azure Functions routing and local development. The transport is configured
 * in stateless mode (sessionIdGenerator = undefined) so each request is handled
 * independently — required for serverless/Azure Functions deployment.
 */
export function createMcpExpressApp(): express.Express {
  const expressApp = express();
  expressApp.use(express.json({ limit: "1mb", strict: true }));

  expressApp.use((_req: Request, res: Response, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const setMcpHttpHeaders = (req: Request, res: Response): void => {
    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "accept, content-type, mcp-protocol-version, mcp-session-id, last-event-id, authorization, x-functions-key, x-servicenow-access-token"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Vary", "Origin");

    // Only echo Access-Control-Allow-Origin for explicitly allowlisted origins.
    // The MCP endpoint is primarily called server-to-server (Copilot Studio
    // backend, smoke tests), so the default empty allowlist is correct. Browser
    // clients must opt in via the CORS_ALLOWED_ORIGINS env var.
    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin === "string" && config.http.corsAllowedOrigins.includes(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
  };

  const normalizeAcceptHeader = (req: Request): void => {
    const current = req.headers.accept;
    const normalized = Array.isArray(current) ? current.join(",") : (current || "");
    const acceptsJson = normalized.includes("application/json") || normalized.includes("*/*");
    const acceptsSse = normalized.includes("text/event-stream") || normalized.includes("*/*");

    if (!acceptsJson || !acceptsSse) {
      (req.headers as Record<string, string | string[] | undefined>).accept = "application/json, text/event-stream";
    }
  };

  const ensureRawHeaders = (req: Request): void => {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          pairs.push(key, String(entry));
        }
      } else if (typeof value !== "undefined") {
        pairs.push(key, String(value));
      }
    }

    (req as unknown as { rawHeaders?: string[] }).rawHeaders = pairs;
  };

  // Health / readiness probe used by Azure to verify the function is up
  expressApp.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "servicenow-mcp" });
  });

  // Request/response logging middleware: captures timing and errors, suppresses noisy internals
  expressApp.use((req: Request, res: Response, next) => {
    const startTime = Date.now();
    const method = req.method;
    const path = req.path;
    // Capture the MCP method/tool name up-front (req.body is consumed by the
    // transport later). Cheap and PII-safe — name only, never arguments.
    const mcpSummary = method === "POST" && path === MCP_PATH ? summarizeMcpBody(req.body) : undefined;

    // Hook response finish to log after response is sent
    res.on("finish", () => {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;

      if (method === "GET" && path === "/health") {
        Logger.debug("Health check", { operation: "health_check", statusCode, durationMs });
      } else if (method === "GET") {
        Logger.debug("SSE stream opened", { operation: "sse_open", statusCode, durationMs });
      } else if (method === "OPTIONS") {
        Logger.debug("CORS preflight", { operation: "cors_preflight", statusCode, durationMs });
      } else if (method === "DELETE") {
        Logger.debug("Session cleanup", { operation: "session_cleanup", statusCode, durationMs });
      } else if (method === "POST") {
        Logger.info("MCP tool call completed", {
          operation: "tool_call",
          mcpMethod: mcpSummary,
          statusCode,
          durationMs
        });
      }
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // Entra ID Bearer token validation
  // ---------------------------------------------------------------------------
  // When ENTRA_TENANT_ID and ENTRA_CLIENT_ID are configured (and
  // ENTRA_AUTH_DISABLED is not true), POST requests to the MCP endpoint must
  // carry a valid Entra access token in the Authorization: Bearer header.
  // GET (SSE readiness), DELETE (session cleanup), and OPTIONS (CORS preflight)
  // are explicitly exempted — only POST carries MCP tool payloads.
  // Validated caller identity is forwarded through RequestContext so tools can
  // log or use it.  The ServiceNow service account is still used for API calls
  // unless the caller also supplies x-servicenow-access-token.
  expressApp.use((req: Request, res: Response, next) => {
    const entra = config.entraAuth;

    // Skip when Entra auth is explicitly disabled (local dev only).
    if (entra.disabled) {
      next();
      return;
    }

    // Only enforce Bearer token auth on POST requests (MCP JSON-RPC calls).
    // GET, DELETE, and OPTIONS are used for SSE, session management, and CORS
    // and must remain accessible without a token.
    if (req.method !== "POST") {
      next();
      return;
    }

    // Within POST, only the data-bearing MCP method (tools/call) requires a valid
    // per-user Entra token. The discovery handshake (initialize, tools/list,
    // resources/* widget-HTML fetch, prompts/list, ping, notifications) is left
    // open so that the Microsoft 365 Copilot / Cowork orchestrator and the widget
    // host can enumerate tools and load widget markup BEFORE the user signs in —
    // their pre-flight uses no user token, and a 401 there makes the plugin look
    // unreachable (empty response, no sign-in prompt). Per the Copilot plugin
    // authentication guidance, the 401 that triggers the sign-in prompt must come
    // from the authenticated data call (tools/call), which still fail-closes here
    // and preserves per-user identity for every ServiceNow operation.
    if (!postBodyRequiresAuth(req.body)) {
      next();
      return;
    }

    // For tools/call the middleware fail-closes on partial configuration
    // (returns 503 when tenantId or clientId is missing).
    entraAuthMiddleware(req, res, next);
  });

  expressApp.use((req: Request, res: Response, next) => {
    // Reject anything that isn't the MCP endpoint up-front so /health (and any
    // unrelated path served by Express in standalone mode) reach their dedicated
    // handlers instead of returning a misleading SSE 200 below.
    if (req.path !== MCP_PATH) {
      next();
      return;
    }

    setMcpHttpHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/event-stream");
      res.status(200).send(": mcp endpoint ready\n\n");
      return;
    }

    if (req.method === "DELETE") {
      res.status(204).end();
      return;
    }

    next();
  });

  // Serve MCP over Streamable HTTP transport (stateless mode)
  // Use app.use as Express 5-compatible route handler.
  expressApp.use(async (req: Request, res: Response): Promise<void> => {
    if (req.path !== MCP_PATH) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "unsupported_media_type" });
      return;
    }

    const server = new McpServer({
      name: "servicenow-mcp",
      version: "1.0.0"
    });

    registerTools(server, sharedServiceNowClient, sharedTokenManager);

    // Copilot Studio currently appears sensitive to extra MCP SDK fields such as
    // execution metadata and some richer JSON Schema keywords. Override tools/list
    // with a minimal manifest while leaving tool execution on the SDK path.
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: getMinimalToolDefinitions()
    }));

    const transport = new StreamableHTTPServerTransport({
      // stateless mode: no session affinity required.
      //
      // The M365 Copilot Cowork host re-attaches `Mcp-Session-Id` to widget
      // callbacks ONLY when the server returns one in `initialize`. Because
      // we never assign a session id, every widget-initiated `tools/call` or
      // `resources/read` lands as a fresh stateless POST — which is exactly
      // what serverless hosting on Azure Functions can guarantee. Introducing
      // session affinity here would require sticky-session handling on the
      // function app and is intentionally out of scope.
      sessionIdGenerator: undefined,
      // Some clients fail to parse SSE-wrapped JSON-RPC responses during discovery.
      // Force JSON responses for compatibility while keeping Streamable HTTP semantics.
      enableJsonResponse: true
    });

    try {
      await server.connect(transport);
      // Pass the parsed JSON body so the transport doesn't need to re-read the stream
      const serviceNowAccessToken = req.header("x-servicenow-access-token") || undefined;
      const callerEntraObjectId = (res.locals.callerEntraObjectId as string | undefined);
      const callerUpn = (res.locals.callerUpn as string | undefined);
      const callerEntraAccessToken = (res.locals.callerAccessToken as string | undefined);

      await runWithRequestContext(
        {
          serviceNowAccessToken,
          callerEntraObjectId,
          callerUpn,
          callerEntraAccessToken
        },
        async () => {
          normalizeAcceptHeader(req);
          ensureRawHeaders(req);
          await transport.handleRequest(req, res, req.body);
        }
      );

      res.on("finish", () => {
        transport.close().catch((error: unknown) => {
          Logger.warn("Failed to close MCP transport", { operation: "transport.close_failed" }, error);
        });
        server.close().catch((error: unknown) => {
          Logger.warn("Failed to close MCP server", { operation: "server.close_failed" }, error);
        });
      });
    } catch (err) {
      Logger.error("MCP request handling error", { operation: "mcp.request_failed" }, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_server_error" });
      }
    }
  });

  return expressApp;
}
