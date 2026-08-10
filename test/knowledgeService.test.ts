import { describe, expect, it, vi } from "vitest";
import { ServiceNowClient } from "../src/services/servicenowClient";
import type { TokenManager } from "../src/services/tokenManager";

function makeClient(get: ReturnType<typeof vi.fn>): ServiceNowClient {
  const client = new ServiceNowClient({} as TokenManager);
  (client as unknown as { httpClient: { get: ReturnType<typeof vi.fn> } }).httpClient = { get };
  return client;
}

describe("ServiceNowClient Knowledge methods", () => {
  it("normalizes a bounded Knowledge API search in one call", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        articles: [{
            id: `kb_knowledge:${"a".repeat(32)}`,
            score: "0.85",
            rank: "2",
            fields: {
              number: "KB0010001",
              short_description: "VPN <b>authentication</b>",
              snippet: "Reset &amp; reconnect",
              kb_knowledge_base: { display_value: "Employee IT" },
              kb_category: { display_value: "Network" },
              sys_updated_on: "2026-08-01"
            }
          }]
      }
    });
    const client = makeClient(get);

    const result = await client.searchKnowledgeArticles("vpn authentication", { language: "en", candidateLimit: 15 });

    expect(get).toHaveBeenCalledTimes(1);
    const config = get.mock.calls[0][1] as { params: URLSearchParams };
    expect(get).toHaveBeenCalledWith("/api/sn_km_api/knowledge/articles", expect.any(Object));
    expect(config.params.get("query")).toBe("vpn authentication");
    expect(config.params.get("limit")).toBe("15");
    expect(config.params.get("language")).toBe("en");
    expect(config.params.getAll("fields")).toContain("short_description");
    expect(result[0]).toMatchObject({
      sysId: "a".repeat(32),
      number: "KB0010001",
      title: "VPN authentication",
      snippet: "Reset & reconnect",
      knowledgeBase: "Employee IT",
      category: "Network",
      nativeScore: 0.85,
      nativeRank: 2
    });
  });

  it("normalizes a direct article response and sanitizes its body", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        result: {
          sys_id: "b".repeat(32),
          number: "KB0010002",
          short_description: "Configure VPN",
          text: "<p>Install the client.</p><script>alert(1)</script><p>Sign in.</p>"
        }
      }
    });
    const client = makeClient(get);

    const result = await client.getKnowledgeArticle("b".repeat(32));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]).not.toHaveProperty("params");
    expect(result.content).toContain("Install the client.");
    expect(result.content).not.toContain("<script>");
    expect(result.content).not.toContain("alert(1)");
    expect(result.sourceLink).toContain(`sys_kb_id=${"b".repeat(32)}`);
  });

  it("rejects malformed article ids before making a call", async () => {
    const get = vi.fn();
    const client = makeClient(get);
    await expect(client.getKnowledgeArticle("not-a-sys-id")).rejects.toThrow(/32-character/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("does not silently fall back to the Table API", async () => {
    const get = vi.fn().mockRejectedValue(new Error("Knowledge API unavailable"));
    const client = makeClient(get);
    await expect(client.searchKnowledgeArticles("vpn")).rejects.toThrow("Knowledge API unavailable");
    expect(get).toHaveBeenCalledTimes(1);
  });
});