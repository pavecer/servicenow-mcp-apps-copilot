import { describe, it, expect, vi } from "vitest";
import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withFunctionContext } from "../src/functions/wrap";
import { getRequestContext } from "../src/requestContext";
import Logger from "../src/utils/logger";

describe("withFunctionContext", () => {
  it("binds InvocationContext as the LogSink for the handler scope", async () => {
    const fakeContext = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
      trace: vi.fn()
    } as unknown as InvocationContext;

    const fakeRequest = {} as unknown as HttpRequest;

    const handler = withFunctionContext(async (_req, ctx): Promise<HttpResponseInit> => {
      // Inside the handler, the active RequestContext.logSink should be ctx.
      expect(getRequestContext()?.logSink).toBe(ctx);

      // Logger.* must dispatch through the sink, NOT console.
      Logger.info("inside handler", { operation: "wrap_test" });

      return { status: 200, body: "ok" };
    });

    const response = await handler(fakeRequest, fakeContext);
    expect(response.status).toBe(200);
    expect((fakeContext.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const logged = String((fakeContext.info as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(logged).toContain("inside handler");
    expect(logged).toContain("operation=wrap_test");
  });

  it("does not leak the sink outside the handler invocation", async () => {
    const fakeContext = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as InvocationContext;

    const handler = withFunctionContext(async (): Promise<HttpResponseInit> => ({
      status: 204,
      body: ""
    }));

    await handler({} as HttpRequest, fakeContext);

    // After the handler resolves we are back outside the AsyncLocalStorage scope.
    expect(getRequestContext()).toBeUndefined();
  });
});
