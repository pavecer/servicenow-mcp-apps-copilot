import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { TokenManager } from "../src/services/tokenManager";

// Single-flight guard test for TokenManager.getAccessToken().
//
// Validates the documented behavior in src/services/tokenManager.ts:
// when N callers invoke getAccessToken() concurrently and there is no cached
// token, exactly ONE underlying axios.post call to the ServiceNow OAuth
// endpoint must be issued, and all N callers must receive the same token.

describe("TokenManager single-flight", () => {
  beforeEach(() => {
    // The test directly stubs axios.post and never hits the network.
    vi.spyOn(axios, "post");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues exactly one OAuth request when N callers race on cold start", async () => {
    const N = 8;

    // Resolver lets the test control when the in-flight request completes,
    // so all N callers are guaranteed to enter getAccessToken() before any
    // resolution happens.
    let resolveTokenRequest: (value: { data: { access_token: string; token_type: string; expires_in: number } }) => void = () => undefined;
    const tokenRequestPromise = new Promise<{ data: { access_token: string; token_type: string; expires_in: number } }>((resolve) => {
      resolveTokenRequest = resolve;
    });

    const postSpy = vi.spyOn(axios, "post").mockReturnValue(tokenRequestPromise as ReturnType<typeof axios.post>);

    const manager = new TokenManager();

    // Fire N concurrent getAccessToken() calls. None can complete until we
    // resolve tokenRequestPromise below.
    const callers = Array.from({ length: N }, () => manager.getAccessToken());

    // Now release the single in-flight HTTP call.
    resolveTokenRequest({
      data: {
        access_token: "tok-shared",
        token_type: "Bearer",
        expires_in: 3600
      }
    });

    const results = await Promise.all(callers);

    // 1) Every caller got the same token value.
    expect(results).toHaveLength(N);
    for (const tok of results) {
      expect(tok).toBe("tok-shared");
    }

    // 2) Exactly one underlying axios.post — the single-flight guarantee.
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("subsequent callers within TTL hit the cache and issue zero new requests", async () => {
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        access_token: "tok-cached",
        token_type: "Bearer",
        expires_in: 3600
      }
    });

    const manager = new TokenManager();

    // First call populates the cache.
    const first = await manager.getAccessToken();
    expect(first).toBe("tok-cached");
    expect(postSpy).toHaveBeenCalledTimes(1);

    // Second + third calls (sequential, post-resolution) return the cached
    // token and do NOT trigger another HTTP call.
    const second = await manager.getAccessToken();
    const third = await manager.getAccessToken();

    expect(second).toBe("tok-cached");
    expect(third).toBe("tok-cached");
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight slot on failure so a retry can acquire a fresh token", async () => {
    // First attempt fails on every (grant, style) combination so acquireToken
    // throws; the inFlight slot must be cleared via .finally() in
    // getAccessToken so the next caller can try again.
    const postSpy = vi.spyOn(axios, "post")
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValue({
        data: {
          access_token: "tok-after-retry",
          token_type: "Bearer",
          expires_in: 3600
        }
      });

    const manager = new TokenManager();

    await expect(manager.getAccessToken()).rejects.toThrow(/Unable to acquire ServiceNow OAuth token/);

    // After the failed acquisition resolves, a fresh call must be allowed.
    // (If the inFlight slot stayed set, this would await the rejected promise
    // and throw again instead of issuing a new request.)
    const recovered = await manager.getAccessToken();
    expect(recovered).toBe("tok-after-retry");

    // Failed attempt = 2 calls (request_body + basic auto-fallback).
    // Successful retry = 1 more call. Total >= 3.
    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
