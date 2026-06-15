import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { validateEntraToken, buildAcceptedAudiences } from "../services/entraTokenValidator";
import Logger from "./logger";

/**
 * Shared Entra ID Bearer token validation middleware.
 * Used by both the MCP endpoint (app.ts) and the Catalog REST API (catalogApi.ts).
 *
 * Returns 401 with RFC 6750-compliant WWW-Authenticate headers on all failures:
 * - Missing token        → standard Bearer challenge with resource_metadata
 * - Expired/invalid token → error="invalid_token" so Power Platform triggers refresh
 *
 * Writes validated caller identity to res.locals:
 *   res.locals.callerEntraObjectId  (oid claim)
 *   res.locals.callerUpn            (preferred_username or upn)
 *   res.locals.callerAccessToken    (raw bearer; used by the OBO exchange in
 *                                    src/services/oboTokenService.ts. Never logged.)
 */
export function entraAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const entra = config.entraAuth;

  // Explicit bypass (local dev / smoke tests). MUST never be true in production.
  if (entra.disabled) {
    next();
    return;
  }

  // Fail closed: when not explicitly disabled, both tenantId and clientId are required.
  // Returning 503 (instead of silently allowing the request) prevents a misconfigured
  // deployment from accidentally exposing the MCP endpoint without authentication.
  if (!entra.tenantId || !entra.clientId) {
    Logger.error("Entra auth: misconfigured", {
      operation: "entra_auth_misconfigured",
      hasTenantId: Boolean(entra.tenantId),
      hasClientId: Boolean(entra.clientId)
    });
    res.status(503).json({
      error: "service_unavailable",
      error_description:
        "Entra ID authentication is misconfigured: ENTRA_TENANT_ID and ENTRA_CLIENT_ID are required. " +
        "Set ENTRA_AUTH_DISABLED=true only for local development."
    });
    return;
  }

  const resourceMetadataUrl = `${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource`;
  const authHeader = req.header("Authorization") || req.header("authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    Logger.warn("Entra auth: missing or invalid Bearer token", {
      operation: "entra_auth_missing",
      hasAuthHeader: !!authHeader
    });
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="${req.protocol}://${req.get("host")}", resource_metadata="${resourceMetadataUrl}"`)
      .json({
        error: "unauthorized",
        error_description: "A valid Entra ID Bearer token is required."
      });
    return;
  }

  const token = authHeader.slice(7);
  const acceptedAudiences = buildAcceptedAudiences(
    entra.clientId,
    entra.audience ?? undefined,
    entra.allowedAudiences
  );

  validateEntraToken(token, entra.tenantId, acceptedAudiences, entra.trustedTenantIds, entra.allowAnyTenant)
    .then(payload => {
      Logger.debug("Entra auth: token validated", {
        operation: "entra_auth_success"
      });
      res.locals.callerEntraObjectId = payload.oid;
      res.locals.callerUpn = payload.preferred_username || payload.upn;
      // Surface the raw validated bearer so downstream code can perform an
      // OBO exchange (Pattern A in docs/AUTH_ENTRA_OBO_OKTA.md). The token
      // never leaves the request scope and is never logged.
      res.locals.callerAccessToken = token;
      next();
    })
    .catch(err => {
      const errMsg = err instanceof Error ? err.message : "unknown error";
      const isExpired = errMsg.toLowerCase().includes("expired") || errMsg.toLowerCase().includes("exp");
      Logger.warn("Entra auth: token validation failed", {
        operation: "entra_auth_failed",
        reason: isExpired ? "token_expired" : "invalid_token"
      }, err);
      const wwwAuthenticate = [
        `Bearer realm="${req.protocol}://${req.get("host")}"`,
        `resource_metadata="${resourceMetadataUrl}"`,
        `error="invalid_token"`,
        `error_description="${isExpired ? "The access token has expired" : "The access token is invalid"}"`
      ].join(", ");

      res.status(401).set("WWW-Authenticate", wwwAuthenticate).json({
        error: "unauthorized",
        error_description: `Bearer token validation failed: ${errMsg}`
      });
    });
}

// Module-load startup log: emit a single, loud line stating the effective Entra
// tenant policy so an operator can immediately see in cold-start logs whether
// the deployed Function App is configured for single-tenant, trusted-multi-
// tenant, or open-multi-tenant mode. Particularly important when
// ENTRA_ALLOW_ANY_TENANT=true because that flag accepts tokens from any
// Microsoft tenant and is easy to leave on by accident.
(function logEffectiveTenantPolicy(): void {
  const entra = config.entraAuth;

  if (entra.disabled) {
    Logger.warn("Entra auth DISABLED via ENTRA_AUTH_DISABLED=true. All requests bypass Bearer validation. Never use in production.", {
      operation: "entra_auth_policy",
      mode: "disabled"
    });
    return;
  }

  if (entra.allowAnyTenant) {
    Logger.warn("Entra auth: ENTRA_ALLOW_ANY_TENANT=true \u2014 tokens from ANY Microsoft tenant will be accepted. Verify audience validation and per-call authorization before exposing data. Set ENTRA_TRUSTED_TENANT_IDS instead for the bounded multi-tenant case.", {
      operation: "entra_auth_policy",
      mode: "allow_any_tenant",
      trustedTenantCount: entra.trustedTenantIds.length
    });
    return;
  }

  if (entra.trustedTenantIds.length > 0) {
    Logger.info("Entra auth: trusted-multi-tenant mode", {
      operation: "entra_auth_policy",
      mode: "trusted_multi_tenant",
      trustedTenantCount: entra.trustedTenantIds.length
    });
    return;
  }

  Logger.info("Entra auth: single-tenant mode", {
    operation: "entra_auth_policy",
    mode: "single_tenant",
    hasTenantId: Boolean(entra.tenantId),
    hasClientId: Boolean(entra.clientId)
  });
})();
