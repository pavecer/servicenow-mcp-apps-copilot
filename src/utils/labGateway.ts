import { timingSafeEqual, createHash } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import Logger from "./logger";

/**
 * Lab-only helpers for the AI gateway governance experiment
 * (docs/lab/ai-gateway). Both features are off unless explicitly enabled:
 *
 *   LAB_REQUEST_DIAGNOSTICS=true   one redacted line per MCP POST describing
 *                                  which auth-relevant headers were PRESENT
 *                                  (never their values) and non-PII token claims.
 *   REQUIRE_GATEWAY_HEADER=true    additionally require X-Gateway-Key to match
 *                                  GATEWAY_SHARED_SECRET (constant-time). Entra
 *                                  validation still runs; this never replaces it.
 */
export interface LabGatewaySettings {
  requestDiagnostics: boolean;
  requireGatewayHeader: boolean;
  gatewaySharedSecret: string | undefined;
}

export function readLabGatewaySettings(env: NodeJS.ProcessEnv = process.env): LabGatewaySettings {
  return {
    requestDiagnostics: env.LAB_REQUEST_DIAGNOSTICS === "true",
    requireGatewayHeader: env.REQUIRE_GATEWAY_HEADER === "true",
    gatewaySharedSecret: env.GATEWAY_SHARED_SECRET || undefined
  };
}

export interface TokenShape {
  aud?: string;
  appid?: string;
  idtyp?: string;
  ver?: string;
  hasPreferredUsername: boolean;
  hasScp: boolean;
  hasRoles: boolean;
}

/** Decodes (does NOT verify) the JWT payload and keeps only non-PII shape fields. */
export function describeBearer(headerValue: string | undefined): TokenShape | undefined {
  if (!headerValue || !/^Bearer\s+/i.test(headerValue)) return undefined;
  const parts = headerValue.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) return { hasPreferredUsername: false, hasScp: false, hasRoles: false };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return {
      aud: str(payload.aud),
      appid: str(payload.appid) ?? str(payload.azp),
      idtyp: str(payload.idtyp),
      ver: str(payload.ver),
      hasPreferredUsername: typeof payload.preferred_username === "string" || typeof payload.upn === "string",
      hasScp: typeof payload.scp === "string",
      hasRoles: Array.isArray(payload.roles)
    };
  } catch {
    return { hasPreferredUsername: false, hasScp: false, hasRoles: false };
  }
}

/**
 * Field names deliberately avoid words matched by the logger's sensitive-key
 * pattern (authorization/token/api-key) so booleans are not blanket-redacted.
 */
export function summarizeLabRequest(req: Request): Record<string, unknown> {
  const has = (name: string): boolean => typeof req.headers[name] !== "undefined";
  const shape = describeBearer(req.header("authorization"));
  return {
    present_bearer: Boolean(shape),
    present_gw_runtime_key: has("api-key"),
    present_x_gateway_key: has("x-gateway-key"),
    present_x_forwarded_for: has("x-forwarded-for"),
    present_x_forwarded_host: has("x-forwarded-host"),
    present_ocp_apim_trace: has("ocp-apim-trace") || has("x-ms-apim-request-id") || has("apim-request-id"),
    bearer_aud: shape?.aud,
    bearer_appid: shape?.appid,
    bearer_idtyp: shape?.idtyp,
    bearer_ver: shape?.ver,
    bearer_has_user_name_claim: shape?.hasPreferredUsername,
    bearer_has_scp: shape?.hasScp,
    bearer_has_roles: shape?.hasRoles
  };
}

export function createLabDiagnosticsMiddleware(settings: LabGatewaySettings, mcpPath: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!settings.requestDiagnostics || req.method !== "POST" || req.path !== mcpPath) {
      next();
      return;
    }
    const summary = summarizeLabRequest(req);
    res.on("finish", () => {
      Logger.info("LAB request diagnostics", {
        operation: "lab_request_diagnostics",
        ...summary,
        identity_established: Boolean(res.locals.callerEntraObjectId),
        status: res.statusCode
      });
    });
    next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function gatewayKeyMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  return timingSafeEqual(digest(provided), digest(expected));
}

export function createGatewayHeaderMiddleware(settings: LabGatewaySettings, mcpPath: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!settings.requireGatewayHeader || req.method !== "POST" || req.path !== mcpPath) {
      next();
      return;
    }
    if (!settings.gatewaySharedSecret) {
      Logger.error("Gateway header required but GATEWAY_SHARED_SECRET is not configured", {
        operation: "lab_gateway_header_misconfigured"
      });
      res.status(503).json({ error: "service_unavailable", error_description: "Gateway header enforcement is misconfigured." });
      return;
    }
    if (!gatewayKeyMatches(req.header("x-gateway-key"), settings.gatewaySharedSecret)) {
      Logger.warn("Request rejected: missing or invalid gateway header", {
        operation: "lab_gateway_header_rejected",
        present_x_gateway_key: typeof req.headers["x-gateway-key"] !== "undefined"
      });
      res.status(403).json({ error: "forbidden", error_description: "Requests must arrive through the governed gateway." });
      return;
    }
    next();
  };
}
