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
  value: string | number = "";
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

function mountWidget(payload: Record<string, unknown>): TestElement {
  const root = new TestElement("div");
  const document = {
    createElement: (name: string) => new TestElement(name),
    createTextNode: (value: string) => { const node = new TestElement("#text"); node.textContent = value; return node; },
    getElementById: () => root
  };
  const window = { mcpHost: { applyTheme() {}, getData: () => payload, markRendered() {}, onData: (callback: (data: Record<string, unknown>) => void) => callback(payload) } };
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  new Function("window", "document", html.slice(scriptStart, scriptEnd))(window, document);
  return root;
}

function mountSearchWidget(articleCount: number): TestElement {
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
  const payload = { mode: "search", query: "reset password", attempt: 1, articles, triedArticles: [] };
  return mountWidget(payload);
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

  it("renders sanitized article text with useful semantic structure", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "How do I reset my password?",
      triedArticles: [],
      article: {
        number: "KB0005012",
        title: "Locked out of your computer",
        knowledgeBase: "IT",
        category: "Access",
        updatedOn: "2026-08-10",
        content: "Symptoms\nYou cannot log in.\n\n2 possible resolutions:\n2. Wait 30 minutes.\n4. Contact support.\n\nSupport for Windows 11 ends next year.\nSupport for release 1.2.3.4.5 ends next year.\n\nIT Support USA: +1 858 436 3350\n\n* Check back for updates.\n\n<script>not markup</script>"
      }
    });
    expect(root.querySelectorAll("h2").map(element => element.textContent)).toEqual(["Symptoms", "2 possible resolutions"]);
    expect(root.querySelectorAll("ol")).toHaveLength(1);
    expect(root.querySelectorAll("li").map(element => element.textContent)).toEqual(["Wait 30 minutes.", "Contact support."]);
    expect(root.querySelectorAll("li").map(element => element.value)).toEqual([2, 4]);
    expect(root.querySelectorAll(".article-contact").map(element => element.textContent)).toEqual(["IT Support USA: +1 858 436 3350"]);
    expect(root.querySelectorAll(".article-note").map(element => element.textContent)).toEqual(["Check back for updates."]);
    expect(root.textContent).toContain("Support for Windows 11 ends next year.");
    expect(root.textContent).toContain("Support for release 1.2.3.4.5 ends next year.");
    expect(root.textContent).toContain("<script>not markup</script>");
    expect(root.querySelectorAll(".source-item")).toHaveLength(3);
    expect(html).not.toContain("content.innerHTML");
  });

  it("prefers the safe ServiceNow document structure over plain-text inference", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Workstation security",
      triedArticles: [],
      article: {
        title: "Workstation Security Standard",
        content: "This fallback must not render",
        contentDocument: {
          version: 1,
          truncated: false,
          nodes: [
            { type: "element", tag: "h1", children: [{ type: "text", text: "Mac" }] },
            { type: "element", tag: "h3", children: [{ type: "text", text: "Casper Management Framework" }] },
            { type: "element", tag: "ul", children: [
              { type: "element", tag: "li", children: [
                { type: "text", text: "Install agent" },
                { type: "element", tag: "ul", children: [
                  { type: "element", tag: "li", children: [
                    { type: "element", tag: "strong", children: [{ type: "text", text: "Verify" }] },
                    { type: "text", text: " enrollment" }
                  ] }
                ] }
              ] }
            ] },
            { type: "element", tag: "p", children: [
              { type: "text", text: "Run " },
              { type: "element", tag: "code", children: [{ type: "text", text: "security-check" }] }
            ] }
          ]
        }
      }
    });
    expect(root.querySelectorAll("h2").map(element => element.textContent)).toEqual(["Mac"]);
    expect(root.querySelectorAll("h3").map(element => element.textContent)).toEqual(["Casper Management Framework"]);
    expect(root.querySelectorAll("ul")).toHaveLength(2);
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelectorAll("strong").map(element => element.textContent)).toEqual(["Verify"]);
    expect(root.querySelectorAll("code").map(element => element.textContent)).toEqual(["security-check"]);
    expect(root.textContent).not.toContain("fallback must not render");
    expect(html).toContain('case "h1": case "h2": return "h2"');
    expect(html).not.toContain("content.innerHTML");
  });

  it("labels a shortened article preview instead of silently clipping it", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Long article",
      triedArticles: [],
      article: { title: "Long article", content: "word ".repeat(1100), sourceLink: "https://example.service-now.com/kb" }
    });
    expect(root.querySelectorAll(".preview-note").map(element => element.textContent)).toEqual([
      "Preview shortened. Open the full article in ServiceNow for the remaining content."
    ]);
    expect(html).not.toContain("max-height: 420px");
    expect(html).not.toContain("overflow: hidden; }\n  .content");
  });

  it("bounds structured previews and ignores inherited or unknown tag names", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Structured article",
      triedArticles: [],
      article: {
        title: "Structured article",
        content: "fallback",
        sourceLink: "https://example.service-now.com/kb",
        contentDocument: {
          version: 1,
          truncated: true,
          nodes: [
            { type: "element", tag: "constructor", children: [{ type: "text", text: "Hidden" }] },
            { type: "element", tag: "__proto__", children: [] },
            { type: "element", tag: "p", children: [{ type: "text", text: "Visible preview" }] }
          ]
        }
      }
    });
    expect(root.textContent).toContain("Visible preview");
    expect(root.textContent).not.toContain("Hidden");
    expect(root.querySelectorAll(".preview-note").map(element => element.textContent)).toEqual([
      "Preview shortened. Open the full article in ServiceNow for the remaining content."
    ]);
    expect(html).toContain('default: return ""');
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