import axios, { AxiosInstance } from "axios";
import https from "node:https";
import { config } from "../config";
import {
  RequestedForDiagnostics,
  ServiceNowCatalogItem,
  ServiceNowCatalogItemDetail,
  ServiceNowOrderResult,
  ServiceNowPlaceOrderResponse
} from "../types/servicenow";
import { TokenManager } from "./tokenManager";
import { getDownstreamTokenForCaller, isOboEnabled } from "./oboTokenService";
import { getRequestContext } from "../requestContext";
import Logger from "../utils/logger";

// Maximum number of concurrent ServiceNow REST calls per fan-out batch.
// Keeps load on the ServiceNow instance bounded and avoids tripping per-user
// rate limits when listUserOrders enriches many requests/items at once.
const SERVICENOW_FANOUT_CONCURRENCY = 5;

// Common English filler words stripped when deriving a keyword-only catalog
// search term from a verbose natural-language query. ServiceNow's
// `sysparm_text` keyword search matches these poorly, so a query like
// "I need to order a new laptop." finds nothing while "laptop" finds several.
const CATALOG_SEARCH_STOPWORDS = new Set<string>([
  "a", "an", "the", "i", "we", "you", "me", "my", "our", "your", "to", "for",
  "of", "and", "or", "please", "need", "want", "would", "like", "get", "order",
  "ordering", "request", "requesting", "buy", "purchase", "new", "some", "any",
  "can", "could", "help", "with", "is", "am", "are", "be", "have", "has", "do",
  "does", "this", "that", "it", "on", "in", "at", "as", "give", "show", "find",
  "looking", "look"
]);

/**
 * Builds an ordered list of catalog search terms to try, from most specific to
 * most permissive. The first entry is the caller's verbatim query; subsequent
 * entries progressively strip punctuation and common filler words so a verbose
 * sentence ("I need to order a new laptop.") still surfaces matching items
 * ("laptop"). Duplicates and empties are removed while preserving order.
 */
export function buildSearchTermCandidates(text: string): string[] {
  const candidates: string[] = [];
  const original = (text ?? "").trim();
  if (original) {
    candidates.push(original);
  }

  // Normalize: drop punctuation, collapse whitespace, lowercase for tokenizing.
  const normalized = original
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized && normalized !== original) {
    candidates.push(normalized);
  }

  const tokens = normalized ? normalized.split(" ") : [];
  const keywords = tokens.filter(t => t.length > 1 && !CATALOG_SEARCH_STOPWORDS.has(t));

  if (keywords.length > 0) {
    candidates.push(keywords.join(" "));
    // As a last resort, try each keyword on its own, longest first — the
    // longer words tend to be the more specific nouns the user wants
    // (e.g. "laptop"). Trying EVERY keyword (not just the single longest)
    // matters for multi-word product names where the brand word is longer
    // than the model word: e.g. "google pixel" must still try "pixel" after
    // "google" returns nothing, because ServiceNow's sysparm_text is literal.
    const byLengthDesc = keywords
      .slice()
      .sort((a, b) => b.length - a.length);
    for (const keyword of byLengthDesc) {
      candidates.push(keyword);
    }
  }

  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    const key = c.trim();
    if (key && !seen.has(key.toLowerCase())) {
      seen.add(key.toLowerCase());
      result.push(key);
    }
  }
  return result;
}

/**
 * Tokenizes free text into a lowercase set of alphanumeric words. Used to
 * compare a catalog item's NAME against the user's search query so we can tell
 * when a result is an unambiguous match (e.g. the item "Pixel 4a" when the user
 * asked for a "white Pixel 4a with 256GB").
 */
export function catalogQueryTokens(text: string): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * True when EVERY token of the catalog item's name appears in the user's query
 * tokens — i.e. the user named the item (possibly with extra adjectives/specs).
 * "Pixel 4a" matches the query "white Pixel 4a with 256GB"; "Standard 27 Monitor"
 * does not. An empty name never matches.
 */
export function itemNameMatchesQuery(name: string, queryTokens: Set<string>): boolean {
  const nameTokens = [...catalogQueryTokens(name)];
  if (nameTokens.length === 0) {
    return false;
  }
  return nameTokens.every(token => queryTokens.has(token));
}

/**
 * Runs `worker` for every item in `items` with at most `concurrency` calls in
 * flight at any time. Preserves input order in the returned array. Errors
 * thrown by `worker` propagate to the caller; existing in-flight tasks are
 * still awaited via Promise.all semantics.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}

interface SearchOptions {
  catalogSysId?: string;
  categorySysId?: string;
  limit?: number;
}

interface ServiceNowUserLookupRecord {
  sys_id?: string;
  email?: string;
  user_name?: string;
  [key: string]: unknown;
}

type CallerField = "callerUpn" | "callerEntraObjectId";

interface RequestedForResolution {
  value?: string;
  diagnostics: RequestedForDiagnostics;
}

export interface PlaceOrderInput {
  quantity?: number;
  requestedFor?: string;
  variables: Record<string, string | number | boolean>;
}

export class ServiceNowClient {
  private readonly tokenManager: TokenManager;
  private readonly httpClient: AxiosInstance;

  constructor(tokenManager?: TokenManager) {
    this.tokenManager = tokenManager ?? new TokenManager();

    // One axios instance per ServiceNowClient. The HTTPS keep-alive agent lets
    // multiple ServiceNow REST calls (e.g. listUserOrders enrichment fan-out)
    // reuse a single TLS connection to the instance, eliminating per-call TCP
    // and TLS handshakes (often >150ms each on cold paths).
    const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

    this.httpClient = axios.create({
      baseURL: config.serviceNow.instanceUrl,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      timeout: 20_000,
      httpsAgent
    });

    // Inject the per-request bearer token at call time. Resolution order:
    //   1. x-servicenow-access-token header (explicit caller-provided SN token)
    //   2. OBO exchange of the inbound Entra user token (Pattern A — when
    //      ENTRA_OBO_ENABLED=true, ENTRA_OBO_DOWNSTREAM_SCOPE is set, and the
    //      middleware captured the caller's bearer)
    //   3. Integration-user grant from TokenManager (existing default)
    // Throws when SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true and neither (1)
    // nor (2) produced a per-user token, so ServiceNow ACLs are enforced.
    this.httpClient.interceptors.request.use(async (request) => {
      const ctx = getRequestContext();
      const callerSnToken = ctx?.serviceNowAccessToken;
      const callerEntraToken = ctx?.callerEntraAccessToken;
      const callerOid = ctx?.callerEntraObjectId;

      let token: string | undefined = callerSnToken;
      let source: "caller_header" | "obo" | "integration_user" = "caller_header";

      if (!token && isOboEnabled() && callerEntraToken) {
        try {
          token = await getDownstreamTokenForCaller({
            callerAccessToken: callerEntraToken,
            callerObjectId: callerOid
          });
          source = "obo";
        } catch (err) {
          // When the caller is required to provide identity, do not fall back
          // silently — re-throw so the failure is surfaced to the client.
          if (config.serviceNow.requireCallerAccessToken) {
            throw err;
          }
          Logger.warn("ServiceNow OBO exchange failed; falling back to integration user", {
            operation: "obo.fallback_to_integration",
            callerOid: callerOid ?? null
          }, err);
        }
      }

      if (!token) {
        if (config.serviceNow.requireCallerAccessToken) {
          throw new Error(
            "ServiceNow caller access token is required. Provide x-servicenow-access-token or enable ENTRA_OBO_ENABLED so ServiceNow ACLs are enforced per user."
          );
        }
        token = await this.tokenManager.getAccessToken();
        source = "integration_user";
      }

      request.headers = request.headers ?? {};
      (request.headers as Record<string, string>).Authorization = `Bearer ${token}`;
      // Attach a low-noise breadcrumb so per-request diagnostics know which
      // identity actually authenticated to ServiceNow.
      (request as { __snTokenSource?: string }).__snTokenSource = source;
      return request;
    });
  }

  private static maskValue(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    if (value.length <= 4) {
      return "****";
    }
    return `${value.slice(0, 2)}****${value.slice(-2)}`;
  }

  private shouldIncludeDiagnosticPii(): boolean {
    return config.serviceNow.requestedForDiagnosticsIncludePii;
  }

  private withPiiPolicy(diagnostics: RequestedForDiagnostics): RequestedForDiagnostics {
    if (this.shouldIncludeDiagnosticPii()) {
      return diagnostics;
    }

    return {
      ...diagnostics,
      resolvedRequestedFor: ServiceNowClient.maskValue(diagnostics.resolvedRequestedFor),
      callerUpn: null,
      callerEntraObjectId: null,
      callerValues: [],
      matchedLookupValue: null
    };
  }

  private isLikelyServiceNowSysId(value: string | undefined): boolean {
    return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
  }

  private sanitizeSysparmQueryValue(value: string): string {
    // ServiceNow encoded queries use ^ as a delimiter, strip it from user-derived values.
    return value.replace(/\^/g, "").trim();
  }

  private sanitizeSysparmFieldName(value: string): string {
    const trimmed = value.trim();
    return /^[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : "";
  }

  private getRequestedForLookupFields(): string[] {
    return config.serviceNow.requestedForLookupFields
      .map(field => this.sanitizeSysparmFieldName(field))
      .filter(Boolean);
  }

  private async lookupServiceNowUser(
    client: AxiosInstance,
    candidateValues: string[],
    lookupFields: string[]
  ): Promise<{ sysId?: string; matchedLookupField: string | null; matchedLookupValue: string | null }> {
    if (candidateValues.length === 0 || lookupFields.length === 0) {
      return {
        matchedLookupField: null,
        matchedLookupValue: null
      };
    }

    const lookupClauses: string[] = [];
    for (const candidateValue of candidateValues) {
      for (const field of lookupFields) {
        lookupClauses.push(`${field}=${candidateValue}`);
      }
    }

    if (lookupClauses.length === 0) {
      return {
        matchedLookupField: null,
        matchedLookupValue: null
      };
    }

    const sysparmQuery = `active=true^${lookupClauses.join("^OR")}`;
    const response = await client.get<{ result: ServiceNowUserLookupRecord[] }>("/api/now/table/sys_user", {
      params: {
        sysparm_query: sysparmQuery,
        sysparm_fields: ["sys_id", ...lookupFields].join(","),
        sysparm_limit: 1
      }
    });

    const matchedUser = response.data.result?.[0];
    const resolvedSysId = matchedUser?.sys_id;
    if (!resolvedSysId) {
      return {
        matchedLookupField: null,
        matchedLookupValue: null
      };
    }

    let matchedLookupField: string | null = null;
    let matchedLookupValue: string | null = null;

    for (const field of lookupFields) {
      const rawValue = matchedUser?.[field];
      if (typeof rawValue !== "string" || !rawValue.trim()) {
        continue;
      }

      const normalizedValue = this.sanitizeSysparmQueryValue(rawValue);
      if (candidateValues.includes(normalizedValue)) {
        matchedLookupField = field;
        matchedLookupValue = normalizedValue;
        break;
      }
    }

    return {
      sysId: resolvedSysId,
      matchedLookupField,
      matchedLookupValue
    };
  }

  private getCallerValues(): string[] {
    const requestContext = getRequestContext();
    const values: string[] = [];

    for (const fieldName of config.serviceNow.requestedForCallerFields) {
      const candidateField = fieldName as CallerField;
      if (candidateField !== "callerUpn" && candidateField !== "callerEntraObjectId") {
        continue;
      }

      const rawValue = requestContext?.[candidateField];
      if (!rawValue) {
        continue;
      }

      const normalized = this.sanitizeSysparmQueryValue(rawValue);
      if (normalized) {
        values.push(normalized);
      }
    }

    return [...new Set(values)];
  }

  private async resolveRequestedFor(client: AxiosInstance, explicitRequestedFor?: string): Promise<RequestedForResolution> {
    const requestContext = getRequestContext();
    const requestedFor = explicitRequestedFor?.trim();
    const lookupFields = this.getRequestedForLookupFields();

    if (requestedFor) {
      const explicitValues = [this.sanitizeSysparmQueryValue(requestedFor)].filter(Boolean);

      if (lookupFields.length > 0 && explicitValues.length > 0) {
        try {
          const lookupResult = await this.lookupServiceNowUser(client, explicitValues, lookupFields);
          if (lookupResult.sysId) {
            return {
              value: lookupResult.sysId,
              diagnostics: this.withPiiPolicy({
                source: "explicit",
                explicitRequestedForProvided: true,
                resolvedRequestedFor: lookupResult.sysId,
                callerUpn: requestContext?.callerUpn ?? null,
                callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
                callerValues: explicitValues,
                lookupFields,
                matchedLookupField: lookupResult.matchedLookupField,
                matchedLookupValue: lookupResult.matchedLookupValue
              })
            };
          }
        } catch {
          // Fall back to passing the explicit value through unchanged.
        }
      }

      return {
        value: requestedFor,
        diagnostics: this.withPiiPolicy({
          source: "explicit",
          explicitRequestedForProvided: true,
          resolvedRequestedFor: requestedFor,
          callerUpn: requestContext?.callerUpn ?? null,
          callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
          callerValues: explicitValues,
          lookupFields,
          matchedLookupField: null,
          matchedLookupValue: null
        })
      };
    }

    const callerValues = this.getCallerValues();

    if (callerValues.length === 0) {
      return {
        diagnostics: this.withPiiPolicy({
          source: "none",
          explicitRequestedForProvided: false,
          resolvedRequestedFor: null,
          callerUpn: requestContext?.callerUpn ?? null,
          callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
          callerValues,
          lookupFields,
          matchedLookupField: null,
          matchedLookupValue: null
        })
      };
    }

    if (lookupFields.length > 0) {
      try {
        const lookupResult = await this.lookupServiceNowUser(client, callerValues, lookupFields);
        if (lookupResult.sysId) {
          return {
            value: lookupResult.sysId,
            diagnostics: this.withPiiPolicy({
              source: "caller_lookup",
              explicitRequestedForProvided: false,
              resolvedRequestedFor: lookupResult.sysId,
              callerUpn: requestContext?.callerUpn ?? null,
              callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
              callerValues,
              lookupFields,
              matchedLookupField: lookupResult.matchedLookupField,
              matchedLookupValue: lookupResult.matchedLookupValue
            })
          };
        }
      } catch {
        // Fall through to caller value fallback.
      }
    }

    if (!config.serviceNow.requestedForFallbackToCallerValue) {
      return {
        diagnostics: this.withPiiPolicy({
          source: "none",
          explicitRequestedForProvided: false,
          resolvedRequestedFor: null,
          callerUpn: requestContext?.callerUpn ?? null,
          callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
          callerValues,
          lookupFields,
          matchedLookupField: null,
          matchedLookupValue: null
        })
      };
    }

    // Use first configured caller value (for example callerUpn) when lookup does not resolve.
    return {
      value: callerValues[0],
      diagnostics: this.withPiiPolicy({
        source: "caller_fallback",
        explicitRequestedForProvided: false,
        resolvedRequestedFor: callerValues[0],
        callerUpn: requestContext?.callerUpn ?? null,
        callerEntraObjectId: requestContext?.callerEntraObjectId ?? null,
        callerValues,
        lookupFields,
        matchedLookupField: null,
        matchedLookupValue: null
      })
    };
  }

  private async getClient(): Promise<AxiosInstance> {
    return this.httpClient;
  }

  /**
   * Resolves the caller's (the person placing the order) ServiceNow sys_id from
   * the Entra-derived caller values (UPN/email) in the request context. Used to
   * stamp `opened_by` / `requested_by` so the record reflects the real ordering
   * user instead of the shared integration identity. Returns undefined when the
   * caller cannot be resolved; callers must treat that as "leave as-is".
   */
  private async resolveCallerSysId(client: AxiosInstance): Promise<string | undefined> {
    const callerValues = this.getCallerValues();
    if (callerValues.length === 0) {
      return undefined;
    }
    const lookupFields = this.getRequestedForLookupFields();
    if (lookupFields.length === 0) {
      return undefined;
    }
    try {
      const lookup = await this.lookupServiceNowUser(client, callerValues, lookupFields);
      return lookup.sysId;
    } catch {
      return undefined;
    }
  }

  /**
   * Patches attribution fields on the created sc_request. `requested_for` is the
   * beneficiary; `opened_by` / `requested_by` are the ordering user (caller).
   * No-op when neither value is provided.
   */
  private async patchRequestAttribution(
    client: AxiosInstance,
    requestSysId: string,
    attribution: { requestedForSysId?: string; ownerSysId?: string }
  ): Promise<void> {
    const body: Record<string, string> = {};
    if (attribution.requestedForSysId) {
      body.requested_for = attribution.requestedForSysId;
    }
    if (attribution.ownerSysId) {
      body.opened_by = attribution.ownerSysId;
      body.requested_by = attribution.ownerSysId;
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    await client.patch(`/api/now/table/sc_request/${requestSysId}`, body);
  }

  /**
   * Patches the same attribution fields on every sc_req_item belonging to the
   * request so the line items match the parent. No-op when neither value is set.
   */
  private async patchRequestItemsAttribution(
    client: AxiosInstance,
    requestSysId: string,
    attribution: { requestedForSysId?: string; ownerSysId?: string }
  ): Promise<void> {
    const body: Record<string, string> = {};
    if (attribution.requestedForSysId) {
      body.requested_for = attribution.requestedForSysId;
    }
    if (attribution.ownerSysId) {
      body.opened_by = attribution.ownerSysId;
    }
    if (Object.keys(body).length === 0) {
      return;
    }

    // Fetch all sc_req_item records that belong to this sc_request
    const itemsResponse = await client.get<{ result: Array<{ sys_id: string }> }>(
      "/api/now/table/sc_req_item",
      {
        params: {
          sysparm_query: `request=${requestSysId}`,
          sysparm_fields: "sys_id",
          sysparm_limit: 100
        }
      }
    );

    const items = itemsResponse.data.result || [];
    await mapWithConcurrency(items, SERVICENOW_FANOUT_CONCURRENCY, (item) =>
      client.patch(`/api/now/table/sc_req_item/${item.sys_id}`, body)
    );
  }

  async searchCatalogItems(text: string, options?: SearchOptions): Promise<ServiceNowCatalogItem[]> {
    try {
      Logger.debug("Searching ServiceNow catalog", {
        operation: "catalog.search",
        limit: options?.limit ?? 20,
        catalogSysId: options?.catalogSysId,
        categorySysId: options?.categorySysId
      });

      // ServiceNow's `sysparm_text` does a fairly literal keyword match, so a
      // verbose natural-language query like "I need to order a new laptop."
      // often returns nothing even though "laptop" matches several items. We
      // therefore try the query as-is first, then progressively fall back to a
      // keyword-only form (stopwords + punctuation stripped).
      //
      // Among the candidates we PREFER the first whose results contain an item
      // whose NAME matches the user's query (token-subset). This avoids a
      // verbose query like "white Pixel 4a with 256GB storage" landing on the
      // longest keyword ("storage") and returning unrelated server/DB items —
      // the candidate "pixel" surfaces the actual "Pixel 4a" item. If no
      // candidate yields a name match we fall back to the first non-empty set.
      const attempts = buildSearchTermCandidates(text);
      const queryTokens = catalogQueryTokens(text);

      let items: ServiceNowCatalogItem[] = [];
      let usedTerm = attempts[0] ?? text;
      let fallbackItems: ServiceNowCatalogItem[] | undefined;
      let fallbackTerm: string | undefined;
      for (const term of attempts) {
        const results = await this.runCatalogTextSearch(term, options);
        if (results.length === 0) {
          continue;
        }
        if (results.some(result => itemNameMatchesQuery(result.name, queryTokens))) {
          items = results;
          usedTerm = term;
          break;
        }
        if (!fallbackItems) {
          fallbackItems = results;
          fallbackTerm = term;
        }
      }
      if (items.length === 0 && fallbackItems) {
        items = fallbackItems;
        usedTerm = fallbackTerm ?? usedTerm;
      }

      Logger.debug("Catalog search completed", {
        operation: "catalog.search_completed",
        foundCount: items.length,
        usedTerm,
        attempts: attempts.length
      });

      return items;
    } catch (error) {
      Logger.error("Catalog search failed", {
        operation: "catalog.search_failed"
      }, error);
      throw error;
    }
  }

  private async runCatalogTextSearch(
    text: string,
    options?: SearchOptions
  ): Promise<ServiceNowCatalogItem[]> {
    const client = await this.getClient();

    const params: Record<string, string | number> = {
      sysparm_text: text,
      sysparm_limit: options?.limit ?? 20
    };

    if (options?.catalogSysId) {
      params.sysparm_catalog = options.catalogSysId;
    }

    if (options?.categorySysId) {
      params.sysparm_category = options.categorySysId;
    }

    const response = await client.get<{ result: ServiceNowCatalogItem[] }>("/api/sn_sc/servicecatalog/items", {
      params
    });

    return response.data.result || [];
  }

  async getCatalogItem(itemSysId: string): Promise<ServiceNowCatalogItemDetail> {
    const client = await this.getClient();
    try {
      const response = await client.get<{ result: ServiceNowCatalogItemDetail }>(
        `/api/sn_sc/servicecatalog/items/${itemSysId}`,
        { params: { sysparm_expand_variables: "true" } }
      );
      return response.data.result;
    } catch (error: unknown) {
      // ServiceNow returns 400 when the item sys_id is not found or not accessible
      const axiosError = error as { response?: { status?: number; data?: { error?: { message?: string } } } };
      if (axiosError?.response?.status === 400) {
        const snMessage = axiosError.response.data?.error?.message ?? "Catalog item not found or not accessible";
        Logger.warn("Catalog item not found", { operation: "catalog.get_item", itemSysId });
        throw new Error(`Catalog item '${itemSysId}' not found: ${snMessage}. Use search_catalog_items to find available items and their correct sys_id values.`);
      }
      throw error;
    }
  }

  /**
   * Fetch candidate records for a ServiceNow reference variable so the
   * Adaptive Card can render them as a ChoiceSet rather than a free-text
   * input. Returns at most `limit` rows.
   *
   *   table:        the referenced ServiceNow table (e.g. "sys_user",
   *                 "cmn_location", "std_change_record_producer").
   *   refQualifier: optional encoded query carried from the catalog variable
   *                 (e.g. "retired=false^EQ"). Applied verbatim.
   *   query:        optional sysparm_text-style filter for the user's
   *                 in-progress search (currently unused on first render).
   *   limit:        max records to return; defaults to 25.
   */
  async searchReferenceRecords(
    table: string,
    options: { refQualifier?: string; query?: string; limit?: number } = {}
  ): Promise<Array<{ sys_id: string; display: string }>> {
    const sanitizedTable = table.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/i.test(sanitizedTable)) {
      throw new Error(`Invalid ServiceNow reference table name: '${table}'`);
    }

    const client = await this.getClient();
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));

    // Pull a small set of likely display columns. Different tables use
    // different display fields (sys_user uses "name", cmn_location uses
    // "name", std_change_record_producer uses "short_description", etc.).
    // We over-fetch a few candidate fields and pick the best one per row.
    const params: Record<string, string | number> = {
      sysparm_limit: limit,
      sysparm_fields: "sys_id,name,short_description,email,number,title",
      sysparm_display_value: "true"
    };

    const queryFragments: string[] = [];
    if (options.refQualifier && options.refQualifier.trim()) {
      queryFragments.push(options.refQualifier.trim());
    }
    if (options.query && options.query.trim()) {
      // Restrict to "name LIKE <q> OR short_description LIKE <q>" so callers
      // can prefilter by user text without needing to know the display field.
      const safe = options.query.trim().replace(/\^/g, " ");
      queryFragments.push(`nameLIKE${safe}^ORshort_descriptionLIKE${safe}`);
    }
    if (queryFragments.length > 0) {
      params.sysparm_query = queryFragments.join("^");
    }

    try {
      const response = await client.get<{ result: Array<Record<string, unknown>> }>(
        `/api/now/table/${sanitizedTable}`,
        { params }
      );
      const rows = response.data.result ?? [];
      return rows
        .map(row => {
          const sysId = typeof row.sys_id === "string" ? row.sys_id : "";
          const display =
            (typeof row.name === "string" && row.name.trim()) ||
            (typeof row.short_description === "string" && row.short_description.trim()) ||
            (typeof row.title === "string" && row.title.trim()) ||
            (typeof row.email === "string" && row.email.trim()) ||
            (typeof row.number === "string" && row.number.trim()) ||
            sysId;
          return { sys_id: sysId, display: String(display) };
        })
        .filter(row => row.sys_id);
    } catch (error) {
      Logger.warn("Reference table lookup failed; falling back to free-text input", {
        operation: "catalog.reference_lookup_failed",
        table: sanitizedTable
      });
      return [];
    }
  }

  async placeOrder(itemSysId: string, input: PlaceOrderInput): Promise<ServiceNowPlaceOrderResponse> {
    try {
      const client = await this.getClient();
      const requestedForResolution = await this.resolveRequestedFor(client, input.requestedFor);
      const resolvedRequestedFor = requestedForResolution.value;

      const payload: Record<string, unknown> = {
        sysparm_quantity: input.quantity ?? 1,
        variables: input.variables
      };

      if (resolvedRequestedFor) {
        payload.sysparm_requested_for = resolvedRequestedFor;
      }

      Logger.info("Placing ServiceNow order", {
        operation: "order.place",
        itemSysId,
        quantity: input.quantity ?? 1,
        requestedForSource: requestedForResolution.diagnostics.source,
        usedCallerServiceNowToken: Boolean(getRequestContext()?.serviceNowAccessToken)
      });

      // Resolve the ordering user (caller) for opened_by / requested_by. When no
      // explicit beneficiary was given, requested_for already resolved to the
      // caller, so reuse it and skip a redundant sys_user lookup.
      let ownerSysId: string | undefined;
      if (config.serviceNow.attributeOwnershipToCaller) {
        if (
          !input.requestedFor &&
          typeof resolvedRequestedFor === "string" &&
          this.isLikelyServiceNowSysId(resolvedRequestedFor)
        ) {
          ownerSysId = resolvedRequestedFor;
        } else {
          const resolved = await this.resolveCallerSysId(client);
          ownerSysId = resolved && this.isLikelyServiceNowSysId(resolved) ? resolved : undefined;
        }
      }

      const response = await client.post<{ result: ServiceNowOrderResult }>(
        `/api/sn_sc/servicecatalog/items/${itemSysId}/order_now`,
        payload
      );

      // Always use sys_id for the request identifier - it's the reliable primary key
      const requestSysId = response.data.result.sys_id;
      const requestedForSysId =
        typeof resolvedRequestedFor === "string" && this.isLikelyServiceNowSysId(resolvedRequestedFor)
          ? resolvedRequestedFor
          : undefined;
      if (
        typeof requestSysId === "string" &&
        this.isLikelyServiceNowSysId(requestSysId) &&
        (requestedForSysId || ownerSysId)
      ) {
        try {
          const attribution = { requestedForSysId, ownerSysId };
          await this.patchRequestAttribution(client, requestSysId, attribution);
          await this.patchRequestItemsAttribution(client, requestSysId, attribution);
          Logger.debug("Order attribution patched", {
            operation: "order.attribution_patched",
            itemSysId,
            requestSysId,
            requestedForPatched: Boolean(requestedForSysId),
            openedByPatched: Boolean(ownerSysId)
          });
        } catch (error) {
          Logger.warn("Failed to patch order attribution fields", {
            operation: "order.attribution_patch_failed",
            itemSysId,
            requestSysId
          }, error);
        }
      }

      Logger.info("Order placed successfully", {
        operation: "order.placed",
        itemSysId,
        requestSysId: response.data.result.sys_id
      });

      return {
        result: response.data.result,
        requestedForDiagnostics: requestedForResolution.diagnostics
      };
    } catch (error) {
      Logger.error("Order placement failed", {
        operation: "order.place_failed",
        itemSysId
      }, error);
      throw error;
    }
  }

  async listUserOrders(
    limit?: number,
    fields?: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const client = await this.getClient();
    const requestContext = getRequestContext();

    /**
     * Get the current user by looking up based on the requestor's credentials.
     * This will fetch the current user's sys_id to find orders they requested.
     */
    const callerValues = this.getCallerValues();
    let currentUserSysId: string | undefined;

    if (callerValues.length > 0) {
      const lookupFields = this.getRequestedForLookupFields();
      if (lookupFields.length > 0) {
        try {
          const userLookup = await this.lookupServiceNowUser(client, callerValues, lookupFields);
          currentUserSysId = userLookup.sysId;
        } catch {
          // Fall back to using the first caller value if lookup fails
        }
      }
    }

    // If we can't determine the user sys_id, we can't list their orders
    if (!currentUserSysId) {
      Logger.warn("Unable to determine current user sys_id", {
        operation: "orders.list_user_unresolved"
      });
      return [];
    }

    // Build query for non-closed orders where the requesting user is the
    // requester, newest activity first (ORDERBYDESC on sys_updated_on so the
    // most recently created OR changed requests surface at the top of the
    // widget's top-N list).
    const sysparmQuery = `requested_for=${currentUserSysId}^state!=7^state!=6^state!=9^ORDERBYDESCsys_updated_on`;

    const params: Record<string, string | number> = {
      sysparm_query: sysparmQuery,
      sysparm_limit: limit ?? 50,
      // Return display values so choice/reference fields resolve to labels
      // ("Open" instead of the raw state code "1", "David Vecer" instead of a
      // sys_user sys_id). sys_id itself stays the raw GUID under this mode, so
      // the per-request sc_req_item enrichment query below still works.
      sysparm_display_value: "true"
    };

    // Include specific fields if provided, otherwise return common fields.
    // sc_request stores its timestamps in sys_created_on / sys_updated_on (the
    // plain created_on/updated_on columns are usually empty), so fetch both —
    // the widget projection falls back to the sys_* variants.
    const defaultFields = [
      "sys_id",
      "number",
      "short_description",
      "description",
      "state",
      "assignment_group",
      "assigned_to",
      "created_on",
      "updated_on",
      "sys_created_on",
      "sys_updated_on",
      "request_status",
      "requested_for"
    ];

    params.sysparm_fields = (fields || defaultFields).join(",");

    try {
      const response = await client.get<{ result: Array<Record<string, unknown>> }>(
        "/api/now/table/sc_request",
        { params }
      );

      const requests = response.data.result || [];

      // Enrich each request with its related catalog items, capping concurrency
      // so a 50-request page doesn't trigger 50 simultaneous ServiceNow calls.
      const enrichedRequests = await mapWithConcurrency(requests, SERVICENOW_FANOUT_CONCURRENCY, async (request) => {
          const requestSysId = request.sys_id as string;
          try {
            // Fetch related items for this request from sc_req_item table
            const itemsResponse = await client.get<{ result: Array<Record<string, unknown>> }>(
              "/api/now/table/sc_req_item",
              {
                params: {
                  sysparm_query: `request=${requestSysId}`,
                  sysparm_limit: 100,
                  sysparm_fields: [
                    "sys_id",
                    "number",
                    "cat_item",
                    "quantity",
                    "state",
                    "short_description",
                    "description"
                  ].join(",")
                }
              }
            );

            const requestItems = itemsResponse.data.result || [];

            // Enrich each item with catalog item details (also concurrency-capped).
            // The catalog item is referenced by sc_req_item.cat_item (a reference
            // field), not cat_item_id.
            const enrichedItems = await mapWithConcurrency(requestItems, SERVICENOW_FANOUT_CONCURRENCY, async (item) => {
                const catItemRef = item.cat_item as Record<string, unknown> | string | undefined;
                const catItemSysId = typeof catItemRef === "object" ? catItemRef.value : catItemRef;

                if (!catItemSysId) {
                  return item;
                }

                try {
                  const catalogResponse = await client.get<{ result: ServiceNowCatalogItemDetail }>(
                    `/api/sn_sc/servicecatalog/items/${catItemSysId}`,
                    { params: { sysparm_expand_variables: "false" } }
                  );
                  return {
                    ...item,
                    catalogItem: catalogResponse.data.result
                  };
                } catch {
                  // If we can't fetch catalog details, return item as-is
                  return item;
                }
              }
            );

            return {
              ...request,
              requestItems: enrichedItems
            };
          } catch (error) {
            Logger.warn("Failed to enrich request items", {
              operation: "orders.list_enrichment_failed",
              requestSysId
            }, error);
            // Return request without items if enrichment fails
            return {
              ...request,
              requestItems: []
            };
          }
        }
      );

      return enrichedRequests;
    } catch (error) {
      Logger.error("Failed to list user orders", {
        operation: "orders.list_failed"
      }, error);
      throw error;
    }
  }

  async updateOrder(
    requestSysId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const client = await this.getClient();

    try {
      const response = await client.patch<{ result: Record<string, unknown> }>(
        `/api/now/table/sc_request/${requestSysId}`,
        updates
      );

      return response.data.result;
    } catch (error) {
      Logger.error("Failed to update order", {
        operation: "orders.update_failed",
        requestSysId
      }, error);
      throw error;
    }
  }

  /**
   * Fetch a single sc_request along with its child sc_req_item records and
   * any sysapproval_approver rows that reference it. Used by the
   * `get_order_detail` MCP tool (and the corresponding MCP App widget) so the
   * user can review a specific order in detail.
   *
   * Concurrency for the side fetches is bounded by SERVICENOW_FANOUT_CONCURRENCY
   * for the same reasons listUserOrders applies it.
   */
  async getOrderDetail(
    requestSysId: string,
    options?: { includeApprovals?: boolean; itemsLimit?: number }
  ): Promise<{
    order: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
    approvals: Array<Record<string, unknown>>;
  }> {
    const client = await this.getClient();
    const itemsLimit = options?.itemsLimit ?? 50;
    const includeApprovals = options?.includeApprovals !== false;

    try {
      const requestFields = [
        "sys_id",
        "number",
        "short_description",
        "description",
        "state",
        "request_status",
        "stage",
        "approval",
        "requested_for",
        "assigned_to",
        "assignment_group",
        "opened_by",
        "opened_at",
        "created_on",
        "updated_on",
        "sys_created_on",
        "sys_updated_on"
      ].join(",");

      const requestResponse = await client.get<{ result: Record<string, unknown> }>(
        `/api/now/table/sc_request/${requestSysId}`,
        { params: { sysparm_fields: requestFields } }
      );

      const order = requestResponse.data.result;
      if (!order) {
        throw new Error(`ServiceNow request ${requestSysId} not found`);
      }

      const itemsResponse = await client.get<{ result: Array<Record<string, unknown>> }>(
        "/api/now/table/sc_req_item",
        {
          params: {
            sysparm_query: `request=${requestSysId}`,
            sysparm_limit: itemsLimit,
            sysparm_fields: [
              "sys_id",
              "number",
              "cat_item",
              "quantity",
              "state",
              "stage",
              "short_description",
              "description",
              "price",
              "recurring_price",
              "recurring_frequency"
            ].join(",")
          }
        }
      );

      const items = itemsResponse.data.result ?? [];

      // Enrich items with catalog item display data, capped concurrency.
      const enrichedItems = await mapWithConcurrency(items, SERVICENOW_FANOUT_CONCURRENCY, async (item) => {
        const catItem = item.cat_item as Record<string, unknown> | string | undefined;
        const catItemSysId = typeof catItem === "object" ? (catItem?.value as string | undefined) : (catItem as string | undefined);
        if (!catItemSysId) return item;
        try {
          const catalogResponse = await client.get<{ result: ServiceNowCatalogItemDetail }>(
            `/api/sn_sc/servicecatalog/items/${catItemSysId}`,
            { params: { sysparm_expand_variables: "false" } }
          );
          return { ...item, catalogItem: catalogResponse.data.result };
        } catch {
          return item;
        }
      });

      let approvals: Array<Record<string, unknown>> = [];
      if (includeApprovals) {
        try {
          const approvalsResponse = await client.get<{ result: Array<Record<string, unknown>> }>(
            "/api/now/table/sysapproval_approver",
            {
              params: {
                sysparm_query: `sysapproval=${requestSysId}`,
                sysparm_limit: 25,
                sysparm_fields: [
                  "sys_id",
                  "state",
                  "approver",
                  "sysapproval",
                  "comments",
                  "sys_created_on",
                  "sys_updated_on"
                ].join(",")
              }
            }
          );
          approvals = approvalsResponse.data.result ?? [];
        } catch (error) {
          Logger.warn("Failed to fetch approvals for order", {
            operation: "orders.detail_approvals_failed",
            requestSysId
          }, error);
          approvals = [];
        }
      }

      return { order, items: enrichedItems, approvals };
    } catch (error) {
      Logger.error("Failed to fetch order detail", {
        operation: "orders.detail_failed",
        requestSysId
      }, error);
      throw error;
    }
  }
}

