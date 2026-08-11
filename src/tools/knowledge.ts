import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import type { KnowledgeArticleHistoryItem } from "../types/servicenow";
import { rankKnowledgeArticles } from "../utils/knowledgeRanking";
import Logger from "../utils/logger";
import { runWithRequestContext } from "../requestContext";

const articleHistorySchema = z.object({
  sysId: z.string().regex(/^[0-9a-f]{32}$/i),
  number: z.string().max(40),
  title: z.string().max(300),
  rank: z.number().int().min(1).max(20).optional()
});

function publicKnowledgeError(operation: "search" | "detail" | "feedback" | "incident") {
  if (operation === "search") return { code: "KNOWLEDGE_SEARCH_UNAVAILABLE", message: "ServiceNow Knowledge search is temporarily unavailable." };
  if (operation === "detail") return { code: "KNOWLEDGE_ARTICLE_UNAVAILABLE", message: "The selected Knowledge article is unavailable." };
  if (operation === "feedback") return { code: "KNOWLEDGE_FEEDBACK_FAILED", message: "The Knowledge feedback could not be saved." };
  return { code: "KNOWLEDGE_INCIDENT_FAILED", message: "The incident could not be created." };
}

export function buildKnowledgeIncidentDescription(input: {
  originalQuestion: string;
  issueSummary: string;
  attemptCount: number;
  triedArticles: KnowledgeArticleHistoryItem[];
}): string {
  const articleLines = input.triedArticles.length > 0
    ? input.triedArticles.map((article, index) =>
      `${index + 1}. ${article.number || "Knowledge article"} — ${article.title} (${article.sysId})`
    )
    : ["No article was opened."];
  return [
    "Knowledge assistance outcome: Not helpful",
    `Knowledge attempts: ${input.attemptCount}`,
    `Original question: ${input.originalQuestion.trim()}`,
    "",
    `Issue summary: ${input.issueSummary.trim()}`,
    "",
    "Articles tried:",
    ...articleLines
  ].join("\n").slice(0, 4000);
}

export function registerSearchKnowledgeTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "search_knowledge",
    [
      "Search ServiceNow Knowledge for an informational, how-to, policy, or troubleshooting question.",
      "Use one search call per unresolved attempt and pass prior article sys_ids in excludeArticleSysIds.",
      "After attempt 3 the widget offers incident creation, but no incident is created without explicit consent."
    ].join(" "),
    {
      query: z.string().min(2).max(500),
      originalQuestion: z.string().min(2).max(1000),
      attempt: z.number().int().min(1).max(3).default(1),
      excludeArticleSysIds: z.array(z.string().regex(/^[0-9a-f]{32}$/i)).max(20).optional(),
      triedArticles: z.array(articleHistorySchema).max(20).default([]),
      language: z.string().max(20).optional(),
      limit: z.number().int().min(1).max(5).default(5)
    },
    async ({ query, originalQuestion, attempt, excludeArticleSysIds, triedArticles, language, limit }) => {
      try {
        const candidates = await client.searchKnowledgeArticles(query, {
          language,
          candidateLimit: Math.min(20, Math.max(10, limit * 3))
        });
        const ranked = rankKnowledgeArticles(query, candidates, { limit, excludeArticleSysIds });
        return {
          content: [{
            type: "text" as const,
            text: ranked.articles.length > 0
              ? `Found ${ranked.articles.length} relevant ServiceNow Knowledge article(s).`
              : "No matching ServiceNow Knowledge articles were found."
          }],
          structuredContent: {
            mode: "search",
            query,
            originalQuestion,
            attempt,
            rankingSource: ranked.rankingSource,
            articles: ranked.articles,
            contentTreatment: "untrusted_reference_only",
            triedArticles,
            offerIncident: attempt >= 3
          }
        };
      } catch (error) {
        Logger.warn("search_knowledge tool failed", { operation: "tool.search_knowledge", attempt }, error);
        const failure = publicKnowledgeError("search");
        return {
          content: [{ type: "text" as const, text: failure.message }],
          structuredContent: { success: false, mode: "error", errorCode: failure.code, error: failure.message, query, originalQuestion, attempt }
        };
      }
    }
  );
}

export function registerGetKnowledgeArticleTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "get_knowledge_article",
    "Retrieve one caller-visible ServiceNow Knowledge article selected from search_knowledge while preserving the resolution journey.",
    {
      articleSysId: z.string().regex(/^[0-9a-f]{32}$/i),
      originalQuestion: z.string().min(2).max(1000),
      attempt: z.number().int().min(1).max(3),
      triedArticles: z.array(articleHistorySchema).max(20).default([])
    },
    async ({ articleSysId, originalQuestion, attempt, triedArticles }) => {
      try {
        const article = await client.getKnowledgeArticle(articleSysId);
        const history = triedArticles.some(item => item.sysId === article.sysId)
          ? triedArticles
          : [...triedArticles, {
            sysId: article.sysId,
            number: article.number,
            title: article.title
          }];
        return {
          content: [{ type: "text" as const, text: `Opened ServiceNow Knowledge article ${article.number || article.title}.` }],
          structuredContent: {
            mode: "detail",
            article,
            contentTreatment: "untrusted_reference_only",
            originalQuestion,
            attempt,
            triedArticles: history,
            offerIncident: attempt >= 3
          }
        };
      } catch (error) {
        Logger.warn("get_knowledge_article tool failed", { operation: "tool.get_knowledge_article", articleSysId }, error);
        const failure = publicKnowledgeError("detail");
        return {
          content: [{ type: "text" as const, text: failure.message }],
          structuredContent: { success: false, mode: "error", errorCode: failure.code, error: failure.message, originalQuestion, attempt, triedArticles }
        };
      }
    }
  );
}

export function registerSubmitKnowledgeFeedbackTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "submit_knowledge_feedback",
    "Save the caller's explicit helpful or not-helpful response against one ServiceNow Knowledge article.",
    {
      articleSysId: z.string().regex(/^[0-9a-f]{32}$/i),
      useful: z.enum(["yes", "no"]),
      originalQuestion: z.string().min(2).max(1000),
      reason: z.enum(["1", "2", "3", "4"]).optional(),
      rating: z.number().int().min(1).max(5).optional(),
      comments: z.string().max(1000).optional()
    },
    async ({ articleSysId, useful, originalQuestion, reason, rating, comments }) => {
      try {
        await runWithRequestContext(
          { serviceNowRequireCallerIdentity: true },
          () => client.submitKnowledgeFeedback({
            articleSysId,
            useful,
            query: originalQuestion,
            reason: useful === "no" ? reason : undefined,
            rating,
            comments
          })
        );
        return {
          content: [{ type: "text" as const, text: `ServiceNow Knowledge feedback saved as ${useful === "yes" ? "helpful" : "not helpful"}.` }],
          structuredContent: {
            success: true,
            mode: "feedback_confirmation",
            useful,
            articleSysId,
            originalQuestion
          }
        };
      } catch (error) {
        Logger.warn("submit_knowledge_feedback tool failed", { operation: "tool.submit_knowledge_feedback", articleSysId }, error);
        const failure = publicKnowledgeError("feedback");
        return {
          content: [{ type: "text" as const, text: failure.message }],
          structuredContent: { success: false, mode: "error", errorCode: failure.code, error: failure.message, articleSysId, originalQuestion }
        };
      }
    }
  );
}

export function registerCreateIncidentFromKnowledgeTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "create_incident_from_knowledge",
    [
      "Create a ServiceNow incident after Knowledge did not resolve the user's question.",
      "Call only after the user explicitly confirms incident creation.",
      "The incident description is flagged with the Knowledge outcome and attempted articles."
    ].join(" "),
    {
      userConfirmed: z.literal(true),
      originalQuestion: z.string().min(2).max(1000),
      issueSummary: z.string().min(2).max(1000),
      attemptCount: z.literal(3),
      triedArticles: z.array(articleHistorySchema).max(20),
      category: z.string().max(80).optional(),
      urgency: z.enum(["1", "2", "3"]).default("2"),
      impact: z.enum(["1", "2", "3"]).default("3")
    },
    async ({ originalQuestion, issueSummary, attemptCount, triedArticles, category, urgency, impact }) => {
      try {
        const { incident, links } = await runWithRequestContext(
          { serviceNowRequireCallerIdentity: true },
          async () => {
            const createdIncident = await client.createIncident({
              shortDescription: issueSummary,
              description: buildKnowledgeIncidentDescription({ originalQuestion, issueSummary, attemptCount, triedArticles }),
              category: category || "inquiry",
              urgency,
              impact
            });
            let linkResult = { requestedCount: triedArticles.length, linkedCount: 0, failedCount: triedArticles.length };
            try {
              linkResult = await client.linkKnowledgeArticlesToTask(
                createdIncident.sys_id,
                triedArticles.map(article => article.sysId)
              );
            } catch (error) {
              Logger.warn("Knowledge incident created but native article linking failed", {
                operation: "tool.knowledge_incident_linking_failed",
                incidentSysId: createdIncident.sys_id,
                requestedCount: triedArticles.length
              }, error);
            }
            return { incident: createdIncident, links: linkResult };
          }
        );
        const linkNote = links.failedCount > 0
          ? ` ${links.failedCount} Knowledge article link(s) could not be stored; the attempted article history remains in the incident description.`
          : "";
        return {
          content: [{ type: "text" as const, text: `Incident ${incident.number} created after Knowledge assistance.${linkNote}` }],
          structuredContent: {
            success: true,
            mode: "incident_confirmation",
            knowledgeEscalation: true,
            knowledgeOutcome: "not_helpful",
            incident: { number: incident.number, sys_id: incident.sys_id, state: "New", short_description: issueSummary },
            number: incident.number,
            originalQuestion,
            attemptCount,
            triedArticles,
            knowledgeLinks: links
          }
        };
      } catch (error) {
        Logger.warn("create_incident_from_knowledge tool failed", { operation: "tool.create_incident_from_knowledge" }, error);
        const failure = publicKnowledgeError("incident");
        return {
          content: [{ type: "text" as const, text: failure.message }],
          structuredContent: { success: false, mode: "error", errorCode: failure.code, error: failure.message, originalQuestion, attemptCount, triedArticles }
        };
      }
    }
  );
}