import { describe, it, expect } from "vitest";
import { buildSearchTermCandidates } from "../src/services/servicenowClient";

describe("buildSearchTermCandidates", () => {
  it("returns the verbatim query first", () => {
    const out = buildSearchTermCandidates("laptop");
    expect(out[0]).toBe("laptop");
  });

  it("derives a keyword from a verbose natural-language sentence", () => {
    const out = buildSearchTermCandidates("I need to order a new laptop.");
    // The verbose sentence is tried first, then progressively reduced.
    expect(out[0]).toBe("I need to order a new laptop.");
    // "laptop" must appear as one of the fallbacks so a literal SNOW text
    // search can still match catalog items.
    expect(out).toContain("laptop");
  });

  it("strips punctuation and stopwords to surface the meaningful noun", () => {
    const out = buildSearchTermCandidates("Please can you get me a VPN access request?");
    expect(out.some(t => t.includes("vpn"))).toBe(true);
    // The single longest keyword is included as a last-resort term.
    expect(out).toContain("access");
  });

  it("de-duplicates and drops empties", () => {
    const out = buildSearchTermCandidates("laptop");
    expect(new Set(out).size).toBe(out.length);
    expect(out.every(t => t.trim().length > 0)).toBe(true);
  });

  it("handles empty input safely", () => {
    expect(buildSearchTermCandidates("")).toEqual([]);
    expect(buildSearchTermCandidates("   ")).toEqual([]);
  });

  it("keeps a single keyword query as just one candidate", () => {
    const out = buildSearchTermCandidates("monitor");
    expect(out).toEqual(["monitor"]);
  });

  it("tries EVERY keyword (longest first), not just the single longest", () => {
    // ServiceNow's sysparm_text is literal, so a multi-word product name like
    // "google pixel" must fall through to each keyword individually. The brand
    // word "google" is longer than the model word "pixel", so a single-longest
    // fallback would stop at "google" (0 hits on the demo instance) and never
    // try "pixel" (which matches the Pixel 4a item).
    const out = buildSearchTermCandidates("google pixel");
    expect(out).toContain("google");
    expect(out).toContain("pixel");
    // Longest keyword comes before the shorter one.
    expect(out.indexOf("google")).toBeLessThan(out.indexOf("pixel"));
  });

  it("surfaces every keyword from a verbose multi-noun sentence", () => {
    const out = buildSearchTermCandidates("I want a Google Pixel phone");
    expect(out).toContain("google");
    expect(out).toContain("pixel");
    expect(out).toContain("phone");
  });
});
