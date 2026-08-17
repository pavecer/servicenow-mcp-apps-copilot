import { describe, expect, it } from "vitest";
import { rankKnowledgeArticles } from "../src/utils/knowledgeRanking";
import type { ServiceNowKnowledgeCandidate } from "../src/types/servicenow";

function article(overrides: Partial<ServiceNowKnowledgeCandidate>): ServiceNowKnowledgeCandidate {
  return {
    sysId: overrides.sysId ?? "a".repeat(32),
    number: overrides.number ?? "KB0010001",
    title: overrides.title ?? "General help",
    shortDescription: overrides.shortDescription ?? "General employee help",
    snippet: overrides.snippet ?? "",
    keywords: overrides.keywords ?? "",
    knowledgeBase: overrides.knowledgeBase ?? "Employee IT",
    category: overrides.category ?? "Help",
    language: overrides.language ?? "en",
    updatedOn: overrides.updatedOn ?? "2026-08-01",
    publishedOn: overrides.publishedOn ?? "2026-07-01",
    nativeScore: overrides.nativeScore,
    nativeRank: overrides.nativeRank ?? 1
  };
}

describe("rankKnowledgeArticles", () => {
  it("ranks an exact title phrase above a generic candidate", () => {
    const result = rankKnowledgeArticles("vpn authentication", [
      article({ sysId: "a".repeat(32), number: "KB1", title: "General VPN help", nativeRank: 1 }),
      article({ sysId: "b".repeat(32), number: "KB2", title: "VPN authentication", nativeRank: 2 })
    ]);
    expect(result.articles[0]).toMatchObject({ number: "KB2", rank: 1, relevanceBand: "best" });
    expect(result.articles[0].matchReasons).toContain("exact title phrase");
  });

  it("fuses ServiceNow native relevance with local field matching", () => {
    const result = rankKnowledgeArticles("reset password", [
      article({ sysId: "a".repeat(32), number: "KB1", title: "Reset password", nativeScore: 0.3, nativeRank: 2 }),
      article({ sysId: "b".repeat(32), number: "KB2", title: "Password help", snippet: "Reset your password", nativeScore: 0.95, nativeRank: 1 })
    ]);
    expect(result.rankingSource).toBe("native_fused");
    expect(result.articles[0].number).toBe("KB2");
  });

  it("excludes tried articles and keeps at most five", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => article({
      sysId: String(index).padStart(32, "0"),
      number: `KB${index}`,
      title: `VPN setup ${index}`,
      nativeRank: index + 1
    }));
    const result = rankKnowledgeArticles("vpn setup", candidates, {
      excludeArticleSysIds: [candidates[0].sysId],
      limit: 5
    });
    expect(result.articles).toHaveLength(5);
    expect(result.articles.map(item => item.sysId)).not.toContain(candidates[0].sysId);
  });

  it("deduplicates article versions by number and keeps the newest", () => {
    const result = rankKnowledgeArticles("vpn", [
      article({ sysId: "a".repeat(32), number: "KB1", title: "VPN old", updatedOn: "2026-01-01", nativeRank: 1 }),
      article({ sysId: "b".repeat(32), number: "KB1", title: "VPN new", updatedOn: "2026-08-01", nativeRank: 2 })
    ]);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe("VPN new");
  });

  it("uses related bands for weak matches instead of fake confidence", () => {
    const result = rankKnowledgeArticles("vpn", [
      article({ sysId: "a".repeat(32), number: "KB1", title: "Expense policy", nativeRank: 1 })
    ]);
    expect(result.articles[0].relevanceBand).toBe("related");
    expect(result.articles[0].score).toBeTypeOf("number");
  });

  it("does not label an unrelated high-native-score article as a best match", () => {
    const result = rankKnowledgeArticles("vpn authentication", [
      article({ sysId: "a".repeat(32), number: "KB1", title: "Expense policy", nativeScore: 0.99, nativeRank: 1 }),
      article({ sysId: "b".repeat(32), number: "KB2", title: "Office locations", nativeScore: 0.1, nativeRank: 2 })
    ]);
    expect(result.articles[0].number).toBe("KB1");
    expect(result.articles[0].relevanceBand).toBe("related");
  });
});