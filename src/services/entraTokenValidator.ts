import crypto from "node:crypto";
import https from "node:https";
import axios from "axios";

// Shared HTTPS keep-alive agent for JWKS fetches against login.microsoftonline.com.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntraJwk {
  kid?: string;
  kty: string;
  use?: string;
  n?: string;
  e?: string;
  alg?: string;
}

interface JwksCache {
  keys: Map<string, EntraJwk>;
  expiresAtMs: number;
}

export interface EntraTokenPayload {
  oid: string;
  tid: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nbf: number;
  preferred_username?: string;
  upn?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// JWKS cache (module-level singleton; safe per Azure Functions instance)
// ---------------------------------------------------------------------------

const JWKS_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes

// Per-tenant JWKS cache: keyed by tenantId so concurrent requests from
// different Entra tenants never overwrite each other's signing keys.
const jwksCacheByTenant = new Map<string, JwksCache>();

async function fetchJwks(jwksUri: string): Promise<Map<string, EntraJwk>> {
  const { data } = await axios.get<{ keys: EntraJwk[] }>(jwksUri, {
    timeout: 10_000,
    httpsAgent: keepAliveAgent
  });
  return new Map(
    data.keys
      .filter(k => k.kid && k.kty === "RSA" && (!k.use || k.use === "sig"))
      .map(k => [k.kid!, k])
  );
}

/**
 * Returns the signing public key for the given kid, fetching/refreshing the
 * JWKS for the issuing tenant as needed. Cache is scoped per-tenant so that
 * multi-tenant scenarios never mix keys from different identity providers.
 */
async function getSigningKey(kid: string, tenantId: string): Promise<crypto.KeyObject> {
  const jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  const now = Date.now();

  let cache = jwksCacheByTenant.get(tenantId);
  if (!cache || now > cache.expiresAtMs) {
    cache = { keys: await fetchJwks(jwksUri), expiresAtMs: now + JWKS_CACHE_TTL_MS };
    jwksCacheByTenant.set(tenantId, cache);
  }

  let jwk = cache.keys.get(kid);
  if (!jwk) {
    // Signing key not found — the IdP may have rotated keys, refresh once.
    cache = { keys: await fetchJwks(jwksUri), expiresAtMs: now + JWKS_CACHE_TTL_MS };
    jwksCacheByTenant.set(tenantId, cache);
    jwk = cache.keys.get(kid);
    if (!jwk) {
      throw new Error(`Unknown signing key kid=${kid} for tenant ${tenantId}`);
    }
  }

  return crypto.createPublicKey(
    { key: jwk, format: "jwk" } as Parameters<typeof crypto.createPublicKey>[0]
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64urlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function base64urlToBuffer(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Validates a Microsoft Entra ID (Azure AD) v2.0 access token using the
 * tenant's public JWKS endpoint. Uses only Node.js 20 built-ins (node:crypto)
 * plus the project-local axios instance — no extra dependencies.
 *
 * For multi-tenant scenarios, supports validating tokens issued by:
 * - The primary tenant (ENTRA_TENANT_ID)
 * - Trusted remote tenants (ENTRA_TRUSTED_TENANT_IDS)
 * - Any Microsoft tenant (ENTRA_ALLOW_ANY_TENANT=true, use with caution)
 *
 * @param bearerToken  Raw JWT value (without "Bearer " prefix).
 * @param primaryTenantId     Primary/home Entra tenant ID (GUID or domain).
 * @param acceptedAudiences  Set of allowed `aud` values (at least one must match).
 * @param trustedTenantIds   Optional array of trusted remote tenant GUIDs for cross-tenant support.
 * @param allowAnyTenant     Optional boolean to accept tokens from any Microsoft tenant (use with caution).
 */
export async function validateEntraToken(
  bearerToken: string,
  primaryTenantId: string,
  acceptedAudiences: Set<string>,
  trustedTenantIds: string[] = [],
  allowAnyTenant: boolean = false
): Promise<EntraTokenPayload> {
  const parts = bearerToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected three dot-separated segments");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header and payload.
  const header: { kid?: string; alg?: string } = JSON.parse(base64urlDecode(headerB64));
  const payload: EntraTokenPayload = JSON.parse(base64urlDecode(payloadB64));

  if (header.alg && header.alg !== "RS256") {
    throw new Error(`Unsupported signing algorithm: ${header.alg}`);
  }

  if (!header.kid) {
    throw new Error("JWT header missing kid");
  }

  // Extract tenant ID from token's tid claim (tells us which tenant issued the token)
  const tokenTenantId = payload.tid;
  if (!tokenTenantId || typeof tokenTenantId !== "string") {
    throw new Error("Missing or invalid tenant ID (tid) claim in token");
  }

  // Validate tenant: must be primary tenant, a trusted tenant, or any tenant if allowed
  const isTrustedTenant = tokenTenantId === primaryTenantId ||
    trustedTenantIds.includes(tokenTenantId);
  
  if (!isTrustedTenant && !allowAnyTenant) {
    throw new Error(
      `Token issued by untrusted tenant ${tokenTenantId}. ` +
      `Primary tenant: ${primaryTenantId}, ` +
      `Trusted tenants: [${trustedTenantIds.join(", ")}]`
    );
  }

  // Fetch public key and verify RS256 signature using the issuing tenant's JWKS endpoint.
  const publicKey = await getSigningKey(header.kid, tokenTenantId);

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const signatureBuffer = base64urlToBuffer(signatureB64);

  if (!verifier.verify(publicKey, signatureBuffer)) {
    throw new Error(`Invalid JWT signature (kid=${header.kid}, alg=${header.alg ?? "RS256"}, tid=${tokenTenantId})`);
  }

  // Validate standard claims.
  const nowSec = Math.floor(Date.now() / 1_000);

  // Ensure exp is a finite number and present.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Invalid or missing exp claim");
  }

  if (payload.exp < nowSec) {
    throw new Error("Token has expired");
  }

  // Allow up to 5-minute clock skew.
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      throw new Error("Invalid nbf claim");
    }
    if (payload.nbf > nowSec + MAX_CLOCK_SKEW_SECONDS) {
      throw new Error("Token not yet valid (nbf)");
    }
  }

  // Issuer validation: must be a valid Entra v2.0 endpoint for the issuing tenant.
  // The issuer URL always uses the token's tenant ID (from tid claim).
  if (!payload.iss) {
    throw new Error("Missing issuer claim");
  }

  let issUrl: URL;
  try {
    issUrl = new URL(payload.iss);
  } catch {
    throw new Error("Invalid issuer");
  }

  const isV2Issuer = issUrl.hostname === "login.microsoftonline.com";
  const isV1Issuer = issUrl.hostname === "sts.windows.net";

  if (!isV2Issuer && !isV1Issuer) {
    throw new Error(`Invalid issuer host: ${issUrl.hostname} (expected login.microsoftonline.com or sts.windows.net)`);
  }

  const segments = issUrl.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

  let issuerTenant: string;
  if (isV2Issuer) {
    // v2.0 format: https://login.microsoftonline.com/{tid}/v2.0
    if (segments.length < 2 || segments[1] !== "v2.0") {
      throw new Error(`Invalid issuer path for v2.0 token: ${issUrl.pathname}`);
    }
    issuerTenant = segments[0];
  } else {
    // v1.0 format: https://sts.windows.net/{tid}/
    if (segments.length < 1) {
      throw new Error(`Invalid issuer path for v1.0 token: ${issUrl.pathname}`);
    }
    issuerTenant = segments[0];
  }

  if (issuerTenant !== tokenTenantId) {
    throw new Error(`Issuer tenant ${issuerTenant} does not match token tid ${tokenTenantId}`);
  }

  // At least one aud value must be in the accepted set.
  const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!tokenAudiences.some(a => acceptedAudiences.has(a))) {
    throw new Error(
      `Invalid audience: token has [${tokenAudiences.join(", ")}], ` +
      `expected one of [${Array.from(acceptedAudiences).join(", ")}]. ` +
      `Ensure the connector/DCR scope is set to api://<clientId>/access_as_user (not a Microsoft Graph scope).`
    );
  }

  return payload;
}

/**
 * Builds the set of accepted audience values for a given Entra client ID.
 * Always includes the raw GUID and the conventional api:// App ID URI.
 * Additional audiences can be supplied via audienceOverride and additionalAudiences
 * (e.g. from ENTRA_ALLOWED_AUDIENCES env var) for non-standard App ID URIs.
 */
export function buildAcceptedAudiences(
  clientId: string,
  audienceOverride?: string,
  additionalAudiences?: string[]
): Set<string> {
  const audiences = new Set<string>([clientId, `api://${clientId}`]);
  if (audienceOverride && audienceOverride !== clientId) {
    audiences.add(audienceOverride);
  }
  for (const aud of (additionalAudiences ?? [])) {
    if (aud) audiences.add(aud);
  }
  return audiences;
}
