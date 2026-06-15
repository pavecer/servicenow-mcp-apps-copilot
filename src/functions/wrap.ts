import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { runWithRequestContext } from "../requestContext";

/**
 * Wraps an Azure Functions v4 HTTP handler so that its body executes inside a
 * `RequestContext` whose `logSink` is bound to the per-invocation
 * `InvocationContext`. Any `Logger.*` call made inside the handler (or any
 * downstream service it invokes) is then dispatched through
 * `context.log/info/warn/error/debug`, which the Functions Node v4 worker
 * forwards to Application Insights `traces`.
 *
 * Without this wrapper, structured log lines land only in WebJobs storage
 * and are invisible to App Insights — see HANDOVER.md §4 ("custom Logger
 * output not reaching App Insights traces").
 *
 * Inner code may still call `runWithRequestContext({...})` to layer caller
 * identity on top; the merge semantics in `runWithRequestContext` preserve
 * the outer `logSink` so observability is not lost.
 */
export function withFunctionContext(
  handler: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  return (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> =>
    runWithRequestContext({ logSink: context }, () => handler(request, context));
}
