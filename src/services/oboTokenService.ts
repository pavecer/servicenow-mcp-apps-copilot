import { ConfidentialClientApplication, type AuthenticationResult } from "@azure/msal-node";
import { config } from "../config";
import Logger from "../utils/logger";

// On-Behalf-Of (OBO) token exchange service.
//
// Implements Pattern A from docs/AUTH_ENTRA_OBO_OKTA.md: swap the inbound
// Entra user access token (audience = this MCP server) for a downstream
// access token (audience configured via ENTRA_OBO_DOWNSTREAM_SCOPE) that
// ServiceNow will accept once it is configured with Entra ID as an OIDC
// identity provider.
//
// Behavior contract:
//   - Disabled by default. Activated only when ENTRA_OBO_ENABLED=true AND
//     ENTRA_OBO_DOWNSTREAM_SCOPE is set AND a caller token is provided.
//   - Per-user cache keyed on the caller's Entra `oid` claim so concurrent
//     tool calls for the same user reuse a single downstream token.
//   - Single-flight guard prevents N concurrent callers (same user) from
//     stampeding the Entra token endpoint on a cache miss.
//   - On any failure the caller receives a thrown Error; the ServiceNow
//     client interceptor decides whether to fall back or surface the error.

interface CachedOboToken {
  value: string;
  expiresAtEpochMs: number;
}

export interface OboExchangeRequest {
  callerAccessToken: string;
  callerObjectId?: string;
}

// Module-level singletons: one MSAL client and one cache per process.
// MSAL maintains its own internal HTTP keep-alive; we add a per-user
// access-token cache on top because MSAL's built-in token cache is keyed
// on the home account and is not directly addressable with just the OBO
// assertion's `oid` claim.
let cachedMsalClient: ConfidentialClientApplication | undefined;
const tokenCacheByOid = new Map<string, CachedOboToken>();
const inFlightByOid = new Map<string, Promise<string>>();

// Cold-cache key used when the caller did not provide an oid claim. Falls
// back to no caching for that exchange (every call goes out). This is
// extremely unlikely in practice because Entra v2 access tokens always
// include `oid`, but we never want to silently mis-attribute tokens.
const NO_CACHE_KEY = "__no_cache__";

function getOrCreateMsalClient(): ConfidentialClientApplication {
  if (cachedMsalClient) {
    return cachedMsalClient;
  }

  const tenantId = config.entraAuth.tenantId;
  const clientId = config.entraAuth.clientId;
  const clientSecret = config.entraAuth.clientSecret;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "OBO exchange requires ENTRA_TENANT_ID, ENTRA_CLIENT_ID, and ENTRA_CLIENT_SECRET to be set."
    );
  }

  cachedMsalClient = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret
    }
  });
  return cachedMsalClient;
}

function isCacheHit(entry: CachedOboToken | undefined): entry is CachedOboToken {
  return Boolean(entry && Date.now() < entry.expiresAtEpochMs);
}

/**
 * Returns true when the configuration is complete enough to attempt an OBO
 * exchange. The ServiceNow client uses this to decide whether to skip the
 * OBO branch entirely (preserving the existing integration-user fallback).
 */
export function isOboEnabled(): boolean {
  return (
    config.entraAuth.oboEnabled === true &&
    typeof config.entraAuth.oboDownstreamScope === "string" &&
    config.entraAuth.oboDownstreamScope.trim().length > 0
  );
}

/**
 * Exchanges the caller's Entra access token for a downstream token via OBO.
 * Throws on misconfiguration or MSAL failure; never returns an empty string.
 */
export async function getDownstreamTokenForCaller(req: OboExchangeRequest): Promise<string> {
  if (!isOboEnabled()) {
    throw new Error(
      "OBO exchange invoked but ENTRA_OBO_ENABLED is false or ENTRA_OBO_DOWNSTREAM_SCOPE is missing."
    );
  }
  if (!req.callerAccessToken) {
    throw new Error("OBO exchange invoked without a caller access token.");
  }

  const cacheKey = req.callerObjectId && req.callerObjectId.length > 0
    ? req.callerObjectId
    : NO_CACHE_KEY;

  // Fast path: cached, unexpired token for this user.
  if (cacheKey !== NO_CACHE_KEY) {
    const cached = tokenCacheByOid.get(cacheKey);
    if (isCacheHit(cached)) {
      Logger.debug("OBO: using cached downstream token", {
        operation: "obo.cache_hit",
        callerOid: cacheKey,
        expiresInMs: cached.expiresAtEpochMs - Date.now()
      });
      return cached.value;
    }

    // Single-flight: coalesce concurrent misses for the same user.
    const inFlight = inFlightByOid.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const exchange = exchangeAndCache(req, cacheKey).finally(() => {
    if (cacheKey !== NO_CACHE_KEY) {
      inFlightByOid.delete(cacheKey);
    }
  });

  if (cacheKey !== NO_CACHE_KEY) {
    inFlightByOid.set(cacheKey, exchange);
  }

  return exchange;
}

async function exchangeAndCache(req: OboExchangeRequest, cacheKey: string): Promise<string> {
  const msal = getOrCreateMsalClient();
  const scope = config.entraAuth.oboDownstreamScope as string;

  Logger.debug("OBO: requesting downstream token", {
    operation: "obo.request",
    callerOid: cacheKey === NO_CACHE_KEY ? null : cacheKey,
    scope
  });

  let result: AuthenticationResult | null;
  try {
    result = await msal.acquireTokenOnBehalfOf({
      oboAssertion: req.callerAccessToken,
      scopes: [scope]
    });
  } catch (err) {
    Logger.warn("OBO: MSAL acquireTokenOnBehalfOf failed", {
      operation: "obo.request_failed",
      scope
    }, err);
    throw err instanceof Error ? err : new Error("OBO exchange failed");
  }

  if (!result?.accessToken) {
    throw new Error("OBO exchange returned no access token.");
  }

  // MSAL returns expiresOn as a Date. Refresh 30s early to absorb clock skew
  // and the typical request latency to ServiceNow.
  const expiresOnEpochMs = result.expiresOn
    ? result.expiresOn.getTime()
    : Date.now() + 60_000;
  const expiresAtEpochMs = Math.max(Date.now() + 30_000, expiresOnEpochMs - 30_000);

  if (cacheKey !== NO_CACHE_KEY) {
    tokenCacheByOid.set(cacheKey, { value: result.accessToken, expiresAtEpochMs });
  }

  Logger.info("OBO: downstream token acquired", {
    operation: "obo.acquired",
    callerOid: cacheKey === NO_CACHE_KEY ? null : cacheKey,
    cached: cacheKey !== NO_CACHE_KEY,
    expiresInMs: expiresAtEpochMs - Date.now()
  });

  return result.accessToken;
}

/**
 * Test-only: reset module-level singletons so unit tests can install fresh
 * MSAL stubs and start with an empty per-user cache.
 */
export function __resetOboTokenServiceForTests(): void {
  cachedMsalClient = undefined;
  tokenCacheByOid.clear();
  inFlightByOid.clear();
}
