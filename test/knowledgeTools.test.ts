import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKnowledgeIncidentDescription,
  registerCreateIncidentFromKnowledgeTool,
  registerGetKnowledgeArticleTool,
  registerSearchKnowledgeTool
} from "../src/tools/knowledge";
import type { ServiceNowClient } from "../src/services/servicenowClient";
import { getRequestContext } from "../src/requestContext";

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function fakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (name: string, _description: string, _schema: unknown, handler: RegisteredTool["handler"]) => tools.push({ name, handler })
    }
  };
}

describe("Knowledge tools", () => {
  let searchKnowledgeArticles: ReturnType<typeof vi.fn>;
  let getKnowledgeArticle: ReturnType<typeof vi.fn>;
  let createIncident: ReturnType<typeof vi.fn>;
  let client: ServiceNowClient;

  beforeEach(() => {
    searchKnowledgeArticles = vi.fn().mockResolvedValue([{
      sysId: "a".repeat(32), number: "KB1", title: "VPN setup", shortDescription: "Configure VPN",
      snippet: "Install the VPN client", keywords: "vpn", knowledgeBase: "Employee IT",
      category: "Network", language: "en", updatedOn: "2026-08-01", publishedOn: "2026-07-01", nativeRank: 1
    }]);
    getKnowledgeArticle = vi.fn().mockResolvedValue({
      sysId: "a".repeat(32), number: "KB1", title: "VPN setup", shortDescription: "Configure VPN",
      snippet: "Install the VPN client", keywords: "vpn", knowledgeBase: "Employee IT",
      category: "Network", language: "en", updatedOn: "2026-08-01", publishedOn: "2026-07-01",
      nativeRank: 1, content: "Install and sign in.", sourceLink: "https://example.service-now.com/kb_view.do"
    });
    createIncident = vi.fn().mockImplementation(async () => {
      expect(getRequestContext()?.serviceNowRequireCallerIdentity).toBe(true);
      return { number: "INC0010001", sys_id: "b".repeat(32) };
    });
    client = { searchKnowledgeArticles, getKnowledgeArticle, createIncident } as unknown as ServiceNowClient;
  });

  it("searches once, ranks results, and offers an incident on attempt three", async () => {
    const fake = fakeServer();
    registerSearchKnowledgeTool(fake.server as never, client);
    const result = await fake.tools[0].handler({
      query: "vpn setup", originalQuestion: "How do I configure VPN?", attempt: 3,
      excludeArticleSysIds: [], triedArticles: [], limit: 5
    }) as { structuredContent: Record<string, unknown> };
    expect(searchKnowledgeArticles).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ mode: "search", attempt: 3, offerIncident: true });
    expect(result.structuredContent.articles).toHaveLength(1);
  });

  it("preserves tried article history when opening a detail", async () => {
    const fake = fakeServer();
    registerGetKnowledgeArticleTool(fake.server as never, client);
    const result = await fake.tools[0].handler({
      articleSysId: "a".repeat(32), originalQuestion: "How do I configure VPN?", attempt: 2, triedArticles: []
    }) as { structuredContent: Record<string, unknown> };
    expect(getKnowledgeArticle).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ mode: "detail", attempt: 2, offerIncident: false });
    expect(result.structuredContent.triedArticles).toHaveLength(1);
  });

  it("creates one flagged incident after explicit confirmation", async () => {
    const fake = fakeServer();
    registerCreateIncidentFromKnowledgeTool(fake.server as never, client);
    const triedArticles = [{ sysId: "a".repeat(32), number: "KB1", title: "VPN setup", rank: 1 }];
    const result = await fake.tools[0].handler({
      userConfirmed: true,
      originalQuestion: "How do I configure VPN?",
      issueSummary: "VPN setup instructions did not resolve the issue",
      attemptCount: 3,
      triedArticles,
      urgency: "2",
      impact: "3"
    }) as { structuredContent: Record<string, unknown> };
    expect(createIncident).toHaveBeenCalledTimes(1);
    expect(createIncident).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("Knowledge assistance outcome: Not helpful")
    }));
    expect(result.structuredContent).toMatchObject({
      mode: "incident_confirmation", knowledgeEscalation: true, knowledgeOutcome: "not_helpful", number: "INC0010001"
    });
  });

  it("builds a searchable incident history block", () => {
    const description = buildKnowledgeIncidentDescription({
      originalQuestion: "VPN fails",
      issueSummary: "Still cannot connect",
      attemptCount: 3,
      triedArticles: [{ sysId: "a".repeat(32), number: "KB1", title: "VPN setup" }]
    });
    expect(description).toContain("Knowledge attempts: 3");
    expect(description).toContain("KB1 — VPN setup");
  });

  it("supports incident escalation after three zero-result attempts", async () => {
    const fake = fakeServer();
    registerCreateIncidentFromKnowledgeTool(fake.server as never, client);
    await fake.tools[0].handler({
      userConfirmed: true,
      originalQuestion: "How do I configure VPN?",
      issueSummary: "No Knowledge result resolved the question",
      attemptCount: 3,
      triedArticles: [], urgency: "2", impact: "3"
    });
    expect(createIncident).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("No article was opened.")
    }));
  });

  it("returns stable public errors without leaking upstream details", async () => {
    searchKnowledgeArticles.mockRejectedValueOnce(new Error("upstream secret query details"));
    const fake = fakeServer();
    registerSearchKnowledgeTool(fake.server as never, client);
    const result = await fake.tools[0].handler({
      query: "vpn", originalQuestion: "How do I configure VPN?", attempt: 1, triedArticles: [], limit: 5
    }) as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent).toMatchObject({
      success: false,
      errorCode: "KNOWLEDGE_SEARCH_UNAVAILABLE",
      error: "ServiceNow Knowledge search is temporarily unavailable."
    });
    expect(JSON.stringify(result)).not.toContain("upstream secret query details");
  });
});