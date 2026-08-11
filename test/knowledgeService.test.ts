import { describe, expect, it, vi } from "vitest";
import { ServiceNowClient } from "../src/services/servicenowClient";
import type { TokenManager } from "../src/services/tokenManager";
import { config } from "../src/config";

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
          text: "<h3>Mac</h3><ul><li>Install <strong>the client</strong><ul><li>Verify enrollment</li></ul></li></ul><p>Run <code>check</code>.</p><script>alert(1)</script>"
        }
      }
    });
    const client = makeClient(get);

    const result = await client.getKnowledgeArticle("b".repeat(32));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]).not.toHaveProperty("params");
    expect(result.content).toContain("Install the client");
    expect(result.content).not.toContain("<script>");
    expect(result.content).not.toContain("alert(1)");
    expect(result.contentDocument).toMatchObject({
      version: 1,
      truncated: false,
      nodes: [
        { type: "element", tag: "h3", children: [{ type: "text", text: "Mac" }] },
        { type: "element", tag: "ul", children: [
          { type: "element", tag: "li", children: [
            { type: "text", text: "Install " },
            { type: "element", tag: "strong", children: [{ type: "text", text: "the client" }] },
            { type: "element", tag: "ul" }
          ] }
        ] },
        { type: "element", tag: "p", children: [
          { type: "text", text: "Run " },
          { type: "element", tag: "code", children: [{ type: "text", text: "check" }] },
          { type: "text", text: "." }
        ] }
      ]
    });
    expect(JSON.stringify(result.contentDocument)).not.toContain("alert(1)");
    expect(result.content.length).toBeLessThanOrEqual(5_000);
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

  it("uses the opt-in caller-scoped Table API fallback only when the Knowledge endpoint is unavailable", async () => {
    const previous = config.serviceNow.knowledgeTableFallbackEnabled;
    (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = true;
    const get = vi.fn()
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({
        data: {
          result: [
            {
              sys_id: "c".repeat(32), number: "KB3", short_description: "Reset password",
              text: "Use the reset portal", active: "true", workflow_state: "published", valid_to: "2099-01-01"
            },
            {
              sys_id: "d".repeat(32), number: "KB4", short_description: "Expired",
              text: "Old steps", active: "true", workflow_state: "published", valid_to: "2020-01-01"
            }
          ]
        }
      });
    try {
      const client = makeClient(get);
      const result = await client.searchKnowledgeArticles("password reset", { candidateLimit: 10 });
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls[1][0]).toBe("/api/now/table/kb_knowledge");
      expect(get.mock.calls[1][1]).toMatchObject({ __snRequireCallerIdentity: true });
      expect(get.mock.calls[1][1].params.sysparm_query).toContain("123TEXTQUERY321=password reset");
      expect(result.map(article => article.number)).toEqual(["KB3"]);
    } finally {
      (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = previous;
    }
  });

  it("never falls back on authorization failures", async () => {
    const previous = config.serviceNow.knowledgeTableFallbackEnabled;
    (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = true;
    const get = vi.fn().mockRejectedValue({ response: { status: 403 } });
    try {
      const client = makeClient(get);
      await expect(client.searchKnowledgeArticles("password reset")).rejects.toMatchObject({ response: { status: 403 } });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = previous;
    }
  });

  it("uses the opt-in Table API fallback for published article detail", async () => {
    const previous = config.serviceNow.knowledgeTableFallbackEnabled;
    (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = true;
    const get = vi.fn()
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        data: { result: { sys_id: "e".repeat(32), number: "KB5", short_description: "VPN", text: "Steps", active: "true", workflow_state: "published" } }
      });
    try {
      const client = makeClient(get);
      const detail = await client.getKnowledgeArticle("e".repeat(32));
      expect(get.mock.calls[1][0]).toBe(`/api/now/table/kb_knowledge/${"e".repeat(32)}`);
      expect(detail).toMatchObject({
        number: "KB5",
        content: "Steps",
        contentDocument: { version: 1, truncated: false, nodes: [{ type: "text", text: "Steps" }] }
      });
    } finally {
      (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = previous;
    }
  });
});