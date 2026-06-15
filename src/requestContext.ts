import { AsyncLocalStorage } from "node:async_hooks";
import type { LogSink } from "./utils/logger";

export interface RequestContext {
  serviceNowAccessToken?: string;
  callerEntraObjectId?: string;
  callerUpn?: string;
  /**
   * Raw Entra ID access token presented by the caller on the inbound request.
   * Populated by entraAuthMiddleware after successful validation. Consumed by
   * the OBO exchange (src/services/oboTokenService.ts) to mint a downstream
   * token whose audience ServiceNow accepts. Never logged.
   */
  callerEntraAccessToken?: string;
  /**
   * Optional logging sink that wraps the active execution context (e.g. Azure
   * Functions InvocationContext.log/info/warn/error). When set, Logger writes
   * structured log entries through this sink instead of console.* so they are
   * forwarded to Application Insights `traces` rather than only WebJobs storage.
   * Falls back to console.* when undefined (standalone server / unit tests).
   */
  logSink?: LogSink;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs a callback within a request-scoped async context.
 *
 * Use this to propagate caller identity, an optional ServiceNow bearer token,
 * and the per-invocation logging sink to deep service layers without passing
 * parameters through every function.
 *
 * Merge semantics: any field present in `partial` overrides the outer context;
 * fields absent in `partial` are inherited from the surrounding scope. This
 * lets Function-level wrappers establish a `logSink` that inner code (which
 * only knows about caller identity / SN token) can extend without dropping.
 */
export function runWithRequestContext<T>(
  partial: Partial<RequestContext>,
  callback: () => Promise<T>
): Promise<T> {
  const outer = requestContextStorage.getStore();
  const merged: RequestContext = { ...outer, ...partial };
  return requestContextStorage.run(merged, callback);
}

/**
 * Returns the current request context for the active async execution path.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}
