import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const widgetPath = path.join(process.cwd(), "src/ui/widgets/src/knowledge.html");
const html = fs.readFileSync(widgetPath, "utf8");

describe("Knowledge MCP App", () => {
  it("is self-contained and uses only the host bridge", () => {
    expect(html).toContain("<!-- MCP_HOST_BRIDGE -->");
    expect(html).toContain("window.mcpHost");
    expect(html).toContain("callTool(\"get_knowledge_article\"");
    expect(html).toContain("callTool(\"create_incident_from_knowledge\"");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest/);
  });

  it("renders explainable ranking without confidence percentages", () => {
    expect(html).toContain("Best match");
    expect(html).toContain("Strong match");
    expect(html).toContain("Related");
    expect(html).not.toContain("confidence");
    expect(html).not.toContain("article.score");
  });

  it("offers but never automatically creates an incident after attempt three", () => {
    expect(html).toContain("Search attempt \" + (Number(data.attempt) || 1) + \" of 3");
    expect(html).toContain("Nothing is submitted until you choose Create incident");
    expect(html).toContain("userConfirmed: true");
    expect(html).toContain("Create incident");
    expect(html).toContain("Keep searching");
    expect(html).toContain("Use attempt=3");
    expect(html).toContain("triedArticles=");
  });

  it("keeps each rendered state to at most two bottom actions by construction", () => {
    expect(html).toContain('actionButton("Open selected"');
    expect(html).toContain('actionButton("Still need help"');
    expect(html).toContain('actionButton("This solved it"');
    expect(html).toContain('actionButton("Track incident"');
    expect(html).toContain('if (data.offerIncident)');
  });

  it("contains syntactically valid inline JavaScript", () => {
    const scriptStart = html.indexOf("<script>") + "<script>".length;
    const scriptEnd = html.lastIndexOf("</script>");
    expect(scriptStart).toBeGreaterThan("<script>".length - 1);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    expect(() => new Function(html.slice(scriptStart, scriptEnd))).not.toThrow();
  });

  it("provides gated-host recovery, source access, and accessible live states", () => {
    expect(html).toContain("Open the ServiceNow Knowledge article with exactly these arguments");
    expect(html).toContain("View full article in ServiceNow");
    expect(html).toContain('setAttribute("role", "status")');
    expect(html).toContain('setAttribute("role", "alert")');
    expect(html).toContain("Continuing in Copilot");
    expect(html).toContain("Promise.resolve(pending)");
    expect(html).toContain("button.disabled = false");
    expect(html).toContain("next.success === false");
    expect(html).toContain("Continue in chat");
    expect(html).toContain("tried.length === 0");
    expect(html).toContain("keepSearching(data, event.currentTarget)");
    expect(html).toContain("body { margin: 0; padding: 24px;");
    expect(html).toContain("--accent: #479ef5");
  });
});