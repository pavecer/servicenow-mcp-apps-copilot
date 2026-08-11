import { describe, expect, it, vi } from "vitest";
import { ServiceNowClient } from "../src/services/servicenowClient";
import type { TokenManager } from "../src/services/tokenManager";
import { config } from "../src/config";

function makeClient(get: ReturnType<typeof vi.fn>, post: ReturnType<typeof vi.fn> = vi.fn()): ServiceNowClient {
  const client = new ServiceNowClient({} as TokenManager);
  (client as unknown as { httpClient: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } }).httpClient = { get, post };
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
    const get = vi.fn()
      .mockResolvedValueOnce({
        data: {
          result: {
            sys_id: "b".repeat(32),
            number: "KB0010002",
            short_description: "Configure VPN",
            text: "<h3>Mac</h3><img src='https://example.test/step.png'><ul><li>Install <strong>the client</strong><ul><li>Verify enrollment</li></ul></li></ul><p>Run <code>check</code>.</p><script>alert(1)</script>"
          }
        }
      })
      .mockResolvedValueOnce({
        data: { result: [{ file_name: "setup-guide.png", content_type: "image/png", size_bytes: "77404" }] }
      });
    const client = makeClient(get);

    const result = await client.getKnowledgeArticle("b".repeat(32));

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][1]).not.toHaveProperty("params");
    expect(get.mock.calls[1][0]).toBe("/api/now/attachment");
    expect(get.mock.calls[1][1]).toMatchObject({ __snRequireCallerIdentity: true });
    expect(get.mock.calls[1][1].params).toEqual({
      sysparm_query: `table_name=kb_knowledge^table_sys_id=${"b".repeat(32)}^ORDERBYsys_created_on`,
      sysparm_limit: 20,
      sysparm_fields: "file_name,content_type,size_bytes"
    });
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
    expect(result.media).toEqual({
      imageCount: 1,
      attachments: [{ fileName: "setup-guide.png", contentType: "image/png", sizeBytes: 77404 }]
    });
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
      })
      .mockResolvedValueOnce({ data: { result: [] } });
    try {
      const client = makeClient(get);
      const detail = await client.getKnowledgeArticle("e".repeat(32));
      expect(get.mock.calls[1][0]).toBe(`/api/now/table/kb_knowledge/${"e".repeat(32)}`);
      expect(detail).toMatchObject({
        number: "KB5",
        content: "Steps",
        contentDocument: { version: 1, truncated: false, nodes: [{ type: "text", text: "Steps" }] },
        media: { imageCount: 0, attachments: [] }
      });
    } finally {
      (config.serviceNow as { knowledgeTableFallbackEnabled: boolean }).knowledgeTableFallbackEnabled = previous;
    }
  });

  it("keeps article detail available when attachment metadata is inaccessible", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({
        data: { result: { sys_id: "f".repeat(32), number: "KB6", short_description: "Media article", text: "<p>Read this</p>" } }
      })
      .mockRejectedValueOnce({ response: { status: 403 } });
    const client = makeClient(get);

    const detail = await client.getKnowledgeArticle("f".repeat(32));

    expect(detail).toMatchObject({ number: "KB6", content: "Read this", media: { imageCount: 0, attachments: [] } });
  });

  it("locally bounds and normalizes Knowledge attachment summaries", async () => {
    const attachments = Array.from({ length: 25 }, (_, index) => ({
      file_name: index === 0 ? "guide<draft>.pdf\u0000\u202e" : `file-${index}.bin`,
      content_type: index === 0 ? "application/pdf" : "application/octet-stream",
      size_bytes: index === 0 ? "Infinity" : index === 1 ? "-5" : "12.9"
    }));
    const get = vi.fn()
      .mockResolvedValueOnce({
        data: { result: { sys_id: "1".repeat(32), number: "KB7", short_description: "Files", text: "Read" } }
      })
      .mockResolvedValueOnce({ data: { result: attachments } });
    const client = makeClient(get);

    const detail = await client.getKnowledgeArticle("1".repeat(32));

    expect(detail.media.attachments).toHaveLength(20);
    expect(detail.media.attachments[0]).toEqual({ fileName: "guide<draft>.pdf", contentType: "application/pdf", sizeBytes: 0 });
    expect(detail.media.attachments[1].sizeBytes).toBe(0);
    expect(detail.media.attachments[2].sizeBytes).toBe(12);
  });

  it("writes caller-attributed native Knowledge feedback with exact choices", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { result: { sys_id: "2".repeat(32), active: "true", workflow_state: "published", valid_to: "2099-01-01" } }
    });
    const post = vi.fn().mockResolvedValue({ data: { result: { sys_id: "3".repeat(32) } } });
    const client = makeClient(get, post);
    vi.spyOn(client as never, "resolveCallerSysId" as never).mockResolvedValue("4".repeat(32) as never);

    await client.submitKnowledgeFeedback({
      articleSysId: "2".repeat(32), useful: "no", query: "Why does VPN fail?", reason: "3", rating: 2,
      comments: "The order of steps is unclear"
    });

    expect(get).toHaveBeenCalledWith(`/api/now/table/kb_knowledge/${"2".repeat(32)}`, expect.objectContaining({
      __snRequireCallerIdentity: true,
      params: { sysparm_fields: "sys_id,active,workflow_state,valid_to" }
    }));
    expect(post).toHaveBeenCalledWith("/api/now/table/kb_feedback", {
      article: "2".repeat(32), user: "4".repeat(32), useful: "no", query: "Why does VPN fail?",
      reason: "3", rating: 2, comments: "The order of steps is unclear"
    }, expect.objectContaining({ __snRequireCallerIdentity: true }));
  });

  it("does not send a negative reason with helpful feedback", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { result: { sys_id: "2".repeat(32), active: "true", workflow_state: "published" } }
    });
    const post = vi.fn().mockResolvedValue({ data: { result: {} } });
    const client = makeClient(get, post);
    vi.spyOn(client as never, "resolveCallerSysId" as never).mockResolvedValue("4".repeat(32) as never);

    await client.submitKnowledgeFeedback({ articleSysId: "2".repeat(32), useful: "yes", query: "VPN", reason: "1" });

    expect(post.mock.calls[0][1]).not.toHaveProperty("reason");
  });

  it.each([
    [{ workflow_state: "published" }, "missing active"],
    [{ active: "true" }, "missing workflow state"],
    [{ active: "false", workflow_state: "published" }, "inactive"],
    [{ active: "true", workflow_state: "draft" }, "draft"],
    [{ active: "true", workflow_state: "published", valid_to: "2020-01-01" }, "expired"]
  ])("rejects native feedback for an article that is %s", async (article, _label) => {
    const get = vi.fn().mockResolvedValue({ data: { result: { sys_id: "2".repeat(32), ...article } } });
    const post = vi.fn();
    const client = makeClient(get, post);

    await expect(client.submitKnowledgeFeedback({ articleSysId: "2".repeat(32), useful: "yes", query: "VPN" }))
      .rejects.toThrow(/not published or accessible/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("links only caller-visible Knowledge articles and reports unlinked inputs", async () => {
    const first = "5".repeat(32);
    const hidden = "6".repeat(32);
    const get = vi.fn().mockResolvedValue({ data: { result: [{ sys_id: first, active: "true", workflow_state: "published" }] } });
    const post = vi.fn().mockResolvedValue({ data: { result: {} } });
    const client = makeClient(get, post);

    const result = await client.linkKnowledgeArticlesToTask("7".repeat(32), [first, hidden, first]);

    expect(get).toHaveBeenCalledWith("/api/now/table/kb_knowledge", expect.objectContaining({
      __snRequireCallerIdentity: true,
      params: expect.objectContaining({
        sysparm_query: `sys_idIN${first},${hidden}^active=true^workflow_state=published`,
        sysparm_fields: "sys_id,active,workflow_state,valid_to",
        sysparm_limit: 2
      })
    }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/now/table/m2m_kb_task", {
      kb_knowledge: first, task: "7".repeat(32)
    }, expect.objectContaining({ __snRequireCallerIdentity: true }));
    expect(result).toEqual({ requestedCount: 2, linkedCount: 1, failedCount: 1 });
  });

  it("keeps Knowledge task linking best-effort when one native write fails", async () => {
    const first = "8".repeat(32);
    const second = "9".repeat(32);
    const get = vi.fn().mockResolvedValue({ data: { result: [
      { sys_id: first, active: "true", workflow_state: "published" },
      { sys_id: second, active: "true", workflow_state: "published" }
    ] } });
    const post = vi.fn().mockResolvedValueOnce({ data: { result: {} } }).mockRejectedValueOnce({ response: { status: 403 } });
    const client = makeClient(get, post);

    const result = await client.linkKnowledgeArticlesToTask("a".repeat(32), [first, second]);

    expect(result).toEqual({ requestedCount: 2, linkedCount: 1, failedCount: 1 });
  });

  it("does not link expired Knowledge articles to a task", async () => {
    const expired = "b".repeat(32);
    const get = vi.fn().mockResolvedValue({ data: { result: [
      { sys_id: expired, active: "true", workflow_state: "published", valid_to: "2020-01-01" }
    ] } });
    const post = vi.fn();
    const client = makeClient(get, post);

    const result = await client.linkKnowledgeArticlesToTask("c".repeat(32), [expired]);

    expect(post).not.toHaveBeenCalled();
    expect(result).toEqual({ requestedCount: 1, linkedCount: 0, failedCount: 1 });
  });
});