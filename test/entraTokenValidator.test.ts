import { describe, it, expect } from "vitest";
import { buildAcceptedAudiences } from "../src/services/entraTokenValidator";

describe("buildAcceptedAudiences", () => {
  it("includes the bare clientId and the api:// App ID URI by default", () => {
    const audiences = buildAcceptedAudiences("11111111-2222-3333-4444-555555555555");
    expect(audiences.has("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(audiences.has("api://11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(audiences.size).toBe(2);
  });

  it("adds an audience override when it differs from the clientId", () => {
    const audiences = buildAcceptedAudiences(
      "client",
      "https://my-api.contoso.com"
    );
    expect(audiences.has("https://my-api.contoso.com")).toBe(true);
    expect(audiences.has("client")).toBe(true);
    expect(audiences.has("api://client")).toBe(true);
    expect(audiences.size).toBe(3);
  });

  it("ignores an override identical to the clientId", () => {
    const audiences = buildAcceptedAudiences("same-id", "same-id");
    expect(audiences.size).toBe(2); // still the GUID + api://GUID
  });

  it("merges additional audiences and skips empty entries", () => {
    const audiences = buildAcceptedAudiences("client", undefined, [
      "extra-1",
      "",
      "extra-2"
    ]);
    expect(audiences.has("extra-1")).toBe(true);
    expect(audiences.has("extra-2")).toBe(true);
    expect(audiences.has("")).toBe(false);
    expect(audiences.size).toBe(4);
  });
});
