/**
 * Centralized CORS helper used by HTTP-facing endpoints in this server
 * (OIDC discovery, OAuth DCR, the catalog REST API).
 *
 * The MCP endpoint (/mcp) does NOT use this helper because it has its own
 * MCP-specific header set (with Allow + Access-Control-Expose-Headers for
 * mcp-session-id) baked into app.ts.
 *
 * The allowlist is read from `config.http.corsAllowedOrigins`. When the
 * incoming `origin` matches the allowlist, an explicit
 * `Access-Control-Allow-Origin` header is added; otherwise it is omitted
 * (which means the browser will block cross-origin requests for that
 * origin — by design, since wildcard origins are not appropriate for
 * authenticated APIs).
 */
import { config } from "../config";

export interface BuildCorsHeadersOptions {
  /** Methods to advertise. Defaults to "GET, POST, OPTIONS". */
  methods?: string;
  /**
   * Headers the browser is allowed to send. Callers may extend the default
   * set (e.g. catalogApi adds `x-functions-key` and `x-servicenow-access-token`).
   */
  allowedHeaders?: string;
}

const DEFAULT_METHODS = "GET, POST, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization";

export function buildCorsHeaders(
  origin?: string | null,
  options: BuildCorsHeadersOptions = {}
): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": options.methods ?? DEFAULT_METHODS,
    "Access-Control-Allow-Headers": options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS,
    Vary: "Origin"
  };

  if (origin && config.http.corsAllowedOrigins.includes(origin)) {
    base["Access-Control-Allow-Origin"] = origin;
  }

  return base;
}
