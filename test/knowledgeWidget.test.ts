import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const widgetPath = path.join(process.cwd(), "src/ui/widgets/src/knowledge.html");
const html = fs.readFileSync(widgetPath, "utf8");

class TestElement {
  className = "";
  children: TestElement[] = [];
  checked = false;
  disabled = false;
  name = "";
  type = "";
  value = "";
  private ownText = "";

  constructor(readonly tagName: string) {}
  get childNodes() { return this.children; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { this.ownText = ""; this.children = []; }
  appendChild(child: TestElement) { this.children.push(child); return child; }
  addEventListener() {}
  setAttribute() {}
  querySelectorAll(selector: string): TestElement[] {
    const found: TestElement[] = [];
    const visit = (element: TestElement) => {
      for (const child of element.children) {
        if (selector.startsWith(".") ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector() { return null; }
}

function mountSearchWidget(articleCount: number): TestElement {
  const root = new TestElement("div");
  const articles = Array.from({ length: articleCount }, (_, index) => ({
    sysId: String(index + 1).padStart(32, "0"),
    number: `KB${index + 1}`,
    title: `Article ${index + 1}`,
    snippet: "A long but compactable article summary.",
    relevanceBand: index === 0 ? "best" : "related",
    knowledgeBase: "IT",
    category: "Access",
    updatedOn: "2026-08-10 00:30:00"
  }));
  const document = {
    createElement: (name: string) => new TestElement(name),
    createTextNode: (value: string) => { const node = new TestElement("#text"); node.textContent = value; return node; },
    getElementById: () => root
  };
  const payload = { mode: "search", query: "reset password", attempt: 1, articles, triedArticles: [] };
  const window = { mcpHost: { applyTheme() {}, getData: () => payload, markRendered() {}, onData: (callback: (data: typeof payload) => void) => callback(payload) } };
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  new Function("window", "document", html.slice(scriptStart, scriptEnd))(window, document);
  return root;
}

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

  it("keeps ranked results compact with visible, formatted actions and metadata", () => {
    const root = mountSearchWidget(5);
    expect(root.querySelectorAll(".result")).toHaveLength(3);
    expect(root.querySelectorAll(".source-item")).toHaveLength(9);
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Read selected article", "Still need help"]);
    expect(root.textContent).toContain("Showing the top 3 of 5 ranked matches.");
    expect(html).toContain("articles.slice(0, 3)");
    expect(html).toContain("-webkit-line-clamp: 2");
    expect(html).not.toContain("position: sticky");
    expect(html).toContain('timeZone: "UTC"');
    expect(html).toContain('"knowledge-base", "Knowledge base", article.knowledgeBase');
    expect(html).toContain('"category", "Category", article.category');
    expect(html).toContain('"updated", "Updated", formatDate(article.updatedOn)');
    expect(html).toContain(".source-knowledge-base, .source-updated { display: none; }");
    expect(html).toContain('actionButton("Read selected article"');
    expect(html).not.toContain('[article.knowledgeBase, article.category, article.updatedOn]');
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
    expect(html).toContain('actionButton("Read selected article"');
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