import { describe, it, expect } from "vitest";
import { runWithRequestContext, getRequestContext } from "../src/requestContext";

describe("RequestContext (AsyncLocalStorage)", () => {
  it("returns undefined when no context is active", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("propagates the context to nested async callees", async () => {
    const result = await runWithRequestContext(
      { callerUpn: "alice@contoso.com", callerEntraObjectId: "oid-1" },
      async () => {
        const ctx = getRequestContext();
        await Promise.resolve();
        return ctx;
      }
    );

    expect(result).toEqual({
      callerUpn: "alice@contoso.com",
      callerEntraObjectId: "oid-1"
    });
  });

  it("isolates concurrent contexts", async () => {
    const aPromise = runWithRequestContext({ callerUpn: "a" }, async () => {
      await new Promise(r => setTimeout(r, 5));
      return getRequestContext()?.callerUpn;
    });

    const bPromise = runWithRequestContext({ callerUpn: "b" }, async () => {
      await new Promise(r => setTimeout(r, 1));
      return getRequestContext()?.callerUpn;
    });

    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a).toBe("a");
    expect(b).toBe("b");
  });
});
