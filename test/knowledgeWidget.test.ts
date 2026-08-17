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
  required = false;
  name = "";
  type = "";
  value: string | number = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: { currentTarget: TestElement; preventDefault: () => void }) => void>>();
  private ownText = "";

  constructor(readonly tagName: string) {}
  get childNodes() { return this.children; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { this.ownText = ""; this.children = []; }
  appendChild(child: TestElement) { this.children.push(child); return child; }
  addEventListener(name: string, listener: (event: { currentTarget: TestElement; preventDefault: () => void }) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  click() { if (this.disabled) return; for (const listener of this.listeners.get("click") ?? []) listener({ currentTarget: this, preventDefault() {} }); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
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
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function mountWidget(
  payload: Record<string, unknown>,
  options: {
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    sendFollowUp?: (message: string) => Promise<unknown>;
  } = {}
): TestElement {
  const root = new TestElement("div");
  const document = {
    createElement: (name: string) => new TestElement(name),
    createTextNode: (value: string) => { const node = new TestElement("#text"); node.textContent = value; return node; },
    getElementById: () => root
  };
  const window = { mcpHost: {
    applyTheme() {}, getData: () => payload, markRendered() {}, onData: (callback: (data: Record<string, unknown>) => void) => callback(payload),
    callTool: options.callTool, sendFollowUp: options.sendFollowUp
  } };
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

  it("hands articles with omitted media back to the canonical ServiceNow view", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Illustrated setup",
      triedArticles: [],
      article: {
        title: "Illustrated setup",
        content: "Follow these steps.",
        sourceLink: "https://example.service-now.com/kb_view.do?sys_kb_id=123",
        media: {
          imageCount: 3,
          attachments: [
            { fileName: "setup-guide.png", contentType: "image/png", sizeBytes: 77404 },
            { fileName: "reference.pdf", contentType: "application/pdf", sizeBytes: 2097152 },
            { fileName: "diagram.webp", contentType: "image/webp", sizeBytes: 4096 },
            { fileName: "checklist.txt", contentType: "text/plain", sizeBytes: 512 },
            { fileName: "notes.txt", contentType: "text/plain", sizeBytes: 128 }
          ]
        }
      }
    });
    expect(root.querySelectorAll(".media-notice")).toHaveLength(1);
    expect(root.textContent).toContain("3 images and 5 attachments");
    expect(root.textContent).toContain("setup-guide.png · PNG · 76 KB");
    expect(root.textContent).toContain("reference.pdf · PDF · 2.0 MB");
    expect(root.textContent).toContain("+2 more attachments");
    expect(root.textContent).not.toContain("checklist.txt");
    expect(root.querySelector(".media-notice")?.getAttribute("aria-label")).toBe("Article media available in ServiceNow");
    expect(root.querySelectorAll(".source-link")).toHaveLength(0);
    expect(root.querySelectorAll(".button-link").map(element => element.textContent)).toEqual(["Open complete article in ServiceNow"]);
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Give feedback"]);
    expect(root.querySelectorAll("button").length + root.querySelectorAll(".button-link").length).toBe(2);
  });

  it("keeps the standard source link for articles without omitted media", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Text article",
      triedArticles: [],
      article: { title: "Text article", content: "Text only", sourceLink: "https://example.service-now.com/kb", media: { imageCount: 0, attachments: [] } }
    });
    expect(root.querySelectorAll(".media-notice")).toHaveLength(0);
    expect(root.querySelectorAll(".source-link")).toHaveLength(0);
    expect(root.querySelectorAll(".button-link").map(element => element.textContent)).toEqual(["Open in ServiceNow"]);
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Give feedback"]);
  });

  it("uses singular language for one ServiceNow attachment", () => {
    const root = mountWidget({
      mode: "detail",
      attempt: 1,
      originalQuestion: "Attachment article",
      triedArticles: [],
      article: {
        title: "Attachment article",
        content: "Text",
        sourceLink: "https://example.service-now.com/kb",
        media: { imageCount: 0, attachments: [{ fileName: "diagram.png", contentType: "image/png", sizeBytes: 1024 }] }
      }
    });
    expect(root.textContent).toContain("1 attachment that is not shown in this preview");
    expect(root.textContent).not.toContain("Open the complete article in ServiceNow to view");
  });

  it("persists helpful feedback without starting another Knowledge attempt", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const followUps: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => { calls.push({ name, args }); return { success: true, mode: "feedback_confirmation", useful: "yes" }; },
      sendFollowUp: async message => { followUps.push(message); }
    });

    expect(root.textContent).toContain("Feedback is saved to ServiceNow Knowledge");
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[0].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toEqual([{ name: "submit_knowledge_feedback", args: {
      articleSysId: "a".repeat(32), useful: "yes", originalQuestion: "How do I configure VPN?"
    } }]);
    expect(followUps).toEqual([]);
    expect(root.textContent).toContain("Feedback saved in ServiceNow");
    expect(root.textContent).toContain("Glad this article solved your issue");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("collects an optional native reason and shows the saved outcome before continuing", async () => {
    const events: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?",
      triedArticles: [{ sysId: "a".repeat(32), number: "KB1", title: "VPN" }],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => { events.push(`tool:${name}:${args.useful}:${args.reason}`); return { success: true }; },
      sendFollowUp: async () => { events.push("follow-up"); }
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[1].checked = true;
    expect(useful.every(input => input.required)).toBe(true);
    const reasons = root.querySelectorAll("input").filter(input => input.name === "feedback-reason");
    expect(reasons).toHaveLength(4);
    reasons[2].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(events).toEqual(["tool:submit_knowledge_feedback:no:3"]);
    expect(root.textContent).toContain("not-helpful response was saved in ServiceNow");
    expect(root.querySelectorAll(".notice")).toHaveLength(1);
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Continue search"]);

    root.querySelectorAll("button")[0].click();
    await Promise.resolve(); await Promise.resolve();

    expect(events).toEqual(["tool:submit_knowledge_feedback:no:3", "follow-up"]);
  });

  it("includes trimmed comment in not-helpful feedback when provided", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => { calls.push({ name, args }); return { success: true }; },
      sendFollowUp: async () => {}
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[1].checked = true;
    const reasons = root.querySelectorAll("input").filter(input => input.name === "feedback-reason");
    reasons[0].checked = true;
    const textarea = root.querySelector<HTMLTextAreaElement>(".feedback-comment");
    expect(textarea).not.toBeNull();
    expect(textarea!.maxLength).toBe(1000);
    expect(root.querySelectorAll("label").find(label => label.htmlFor === "feedback-comment")?.textContent).toContain("What should this article improve?");
    textarea!.value = "  extra detail  ";
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].args.comments).toBe("extra detail");
  });

  it("omits comment from not-helpful feedback when textarea is blank", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => { calls.push({ name, args }); return { success: true }; },
      sendFollowUp: async () => {}
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[1].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(calls[0].args, "comments")).toBe(false);
  });

  it("omits comment from helpful feedback", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => { calls.push({ name, args }); return { success: true }; },
      sendFollowUp: async () => {}
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[0].checked = true;
    root.querySelector<HTMLTextAreaElement>(".feedback-comment")!.value = "Not sent";
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(calls[0].args, "comments")).toBe(false);
  });

  it("includes trimmed comment in fallback args when not-helpful feedback is gated", async () => {
    const followUps: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async () => { throw new Error("blocked"); },
      sendFollowUp: async (msg: string) => { followUps.push(msg); }
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[1].checked = true;
    const textarea = root.querySelector<HTMLTextAreaElement>(".feedback-comment");
    textarea!.value = "  missing steps  ";
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    root.querySelectorAll("button").find(button => button.textContent === "Save via Copilot")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toContain('"comments":"missing steps"');
  });

  it("preserves trimmed comment when retrying not-helpful feedback", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), number: "KB1", title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return calls.length === 1 ? { success: false, error: "Try again" } : { success: true };
      },
      sendFollowUp: async () => {}
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful");
    useful[1].checked = true;
    root.querySelector<HTMLTextAreaElement>(".feedback-comment")!.value = "  missing steps  ";
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();
    root.querySelectorAll("button").find(button => button.textContent === "Retry feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(calls[1].args.comments).toBe("missing steps");
  });


  it("keeps explicit continuation available when not-helpful feedback cannot be saved", async () => {
    const events: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "How do I configure VPN?", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async () => { events.push("tool-failed"); throw new Error("blocked"); },
      sendFollowUp: async () => { events.push("follow-up"); }
    });

    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[1].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();

    expect(events).toEqual(["tool-failed"]);
    expect(root.textContent).toContain("feedback tool is unavailable in this widget");
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Save via Copilot", "Continue search"]);
    root.querySelectorAll("button").find(button => button.textContent === "Continue search")?.click();
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(["tool-failed", "follow-up"]);
  });

  it("offers retry before attempt-three escalation when feedback persistence fails", async () => {
    const root = mountWidget({
      mode: "detail", attempt: 3, offerIncident: true, originalQuestion: "VPN", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, { callTool: async () => { throw new Error("blocked"); } });
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[1].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Save via Copilot", "Continue without saving"]);
    root.querySelectorAll("button").find(button => button.textContent === "Continue without saving")?.click();
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Create incident", "Keep searching"]);
  });

  it("prevents rapid contradictory feedback writes", async () => {
    let resolveFeedback: ((value: unknown) => void) | undefined;
    const calls: string[] = [];
    const pending = new Promise(resolve => { resolveFeedback = resolve; });
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, { callTool: async (_name, args) => { calls.push(String(args.useful)); return pending; } });
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[0].checked = true;
    const save = root.querySelectorAll("button").find(button => button.textContent === "Save feedback");
    save?.click();
    useful[0].checked = false; useful[1].checked = true; save?.click();
    expect(root.querySelectorAll("button").every(button => button.disabled)).toBe(true);
    expect(calls).toEqual(["yes"]);
    resolveFeedback?.({ success: true, useful: "yes" });
    await Promise.resolve(); await Promise.resolve();
  });

  it("falls back to Copilot with exact feedback arguments when widget calls are gated", async () => {
    const followUps: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN help", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async () => { throw new Error("gated"); },
      sendFollowUp: async message => { followUps.push(message); }
    });
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[1].checked = true;
    const reasons = root.querySelectorAll("input").filter(input => input.name === "feedback-reason"); reasons[0].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();
    root.querySelectorAll("button").find(button => button.textContent === "Save via Copilot")?.click();
    await Promise.resolve(); await Promise.resolve();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toContain("submit_knowledge_feedback");
    expect(followUps[0]).toContain(`\"articleSysId\":\"${"a".repeat(32)}\"`);
    expect(followUps[0]).toContain("\"useful\":\"no\"");
    expect(followUps[0]).toContain("\"reason\":\"1\"");
    expect(followUps[0]).toContain("Search ServiceNow Knowledge again with attempt 2");
  });

  it("locks Save via Copilot against a concurrent continue action", async () => {
    let resolveFollowUp: ((value: unknown) => void) | undefined;
    const followUps: string[] = [];
    const pending = new Promise(resolve => { resolveFollowUp = resolve; });
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN", triedArticles: [], feedbackSaveFailed: "no",
      feedbackFallbackArgs: { articleSysId: "a".repeat(32), useful: "no", originalQuestion: "VPN" },
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, { sendFollowUp: async message => { followUps.push(message); return pending; } });
    const actions = root.querySelectorAll("button");
    actions.find(button => button.textContent === "Save via Copilot")?.click();
    actions.find(button => button.textContent === "Continue search")?.click();
    expect(actions.every(button => button.disabled)).toBe(true);
    expect(followUps).toHaveLength(1);
    resolveFollowUp?.(true);
    await Promise.resolve(); await Promise.resolve();
  });

  it("locks Continue search against a subsequent Save via Copilot action", async () => {
    let resolveFollowUp: ((value: unknown) => void) | undefined;
    const followUps: string[] = [];
    const pending = new Promise(resolve => { resolveFollowUp = resolve; });
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN", triedArticles: [], feedbackSaveFailed: "no",
      feedbackFallbackArgs: { articleSysId: "a".repeat(32), useful: "no", originalQuestion: "VPN" },
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, { sendFollowUp: async message => { followUps.push(message); return pending; } });
    const actions = root.querySelectorAll("button");
    actions.find(button => button.textContent === "Continue search")?.click();
    actions.find(button => button.textContent === "Save via Copilot")?.click();
    expect(actions.every(button => button.disabled)).toBe(true);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toContain("Search ServiceNow Knowledge again with attempt 2");
    resolveFollowUp?.(true);
    await Promise.resolve(); await Promise.resolve();
  });

  it("offers direct retry after a structured helpful-feedback failure", async () => {
    const calls: string[] = [];
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", sourceLink: "https://example.service-now.com/kb", media: { imageCount: 0, attachments: [] } }
    }, { callTool: async (_name, args) => { calls.push(String(args.useful)); return calls.length === 1 ? { success: false, error: "Try again" } : { success: true }; } });
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[0].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Retry feedback"]);
    expect(root.querySelectorAll(".button-link").map(link => link.textContent)).toEqual(["Open in ServiceNow"]);
    root.querySelectorAll("button")[0].click();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toEqual(["yes", "yes"]);
    expect(root.textContent).toContain("Feedback saved in ServiceNow");
  });

  it("reuses one live alert for repeated incomplete feedback submissions", () => {
    const root = mountWidget({
      mode: "detail", attempt: 1, originalQuestion: "VPN", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    });
    root.querySelectorAll("button").find(button => button.textContent === "Give feedback")?.click();
    var save = root.querySelectorAll("button").find(button => button.textContent === "Save feedback");
    save?.click(); save?.click();
    expect(root.querySelectorAll(".transient-status")).toHaveLength(1);
    expect(root.querySelectorAll(".transient-status")[0].getAttribute("role")).toBe("alert");
    expect(root.querySelectorAll(".transient-status")[0].getAttribute("aria-live")).toBe("assertive");
  });

  it("offers incident actions only after attempt-three not-helpful feedback", async () => {
    const root = mountWidget({
      mode: "detail", attempt: 3, offerIncident: true, originalQuestion: "VPN", triedArticles: [],
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, { callTool: async () => ({ success: true }) });
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Give feedback"]);
    root.querySelectorAll("button")[0].click();
    const useful = root.querySelectorAll("input").filter(input => input.name === "feedback-useful"); useful[1].checked = true;
    root.querySelectorAll("button").find(button => button.textContent === "Save feedback")?.click();
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Create incident", "Keep searching"]);
  });

  it("prevents concurrent create-incident and keep-searching commands", async () => {
    let resolveIncident: ((value: unknown) => void) | undefined;
    const calls: string[] = [];
    const pending = new Promise(resolve => { resolveIncident = resolve; });
    const root = mountWidget({
      mode: "detail", attempt: 3, offerIncident: true, originalQuestion: "VPN", triedArticles: [], feedbackSaved: "no",
      article: { sysId: "a".repeat(32), title: "VPN", content: "Steps", media: { imageCount: 0, attachments: [] } }
    }, {
      callTool: async name => { calls.push(name); return pending; },
      sendFollowUp: async () => { calls.push("follow-up"); }
    });
    const actions = root.querySelectorAll("button");
    actions.find(button => button.textContent === "Create incident")?.click();
    actions.find(button => button.textContent === "Keep searching")?.click();
    expect(actions.every(button => button.disabled)).toBe(true);
    expect(calls).toEqual(["create_incident_from_knowledge"]);
    resolveIncident?.({ success: true, mode: "incident_confirmation", number: "INC1" });
    await Promise.resolve(); await Promise.resolve();
  });

  it("renders direct native feedback confirmations", () => {
    const root = mountWidget({ mode: "feedback_confirmation", success: true, useful: "yes", originalQuestion: "VPN" });
    expect(root.textContent).toContain("Feedback saved in ServiceNow");
    expect(root.textContent).toContain("Glad this article solved your issue");
  });

  it("keeps incident success truthful when some native Knowledge links fail", () => {
    const root = mountWidget({
      mode: "incident_confirmation", success: true, number: "INC0010001",
      knowledgeLinks: { requestedCount: 2, linkedCount: 1, failedCount: 1 }
    });
    expect(root.textContent).toContain("Incident INC0010001 created");
    expect(root.textContent).toContain("could not link every Knowledge article");
    expect(root.querySelectorAll("button").map(button => button.textContent)).toEqual(["Track incident"]);
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
    expect(html).toContain('actionButton("Give feedback"');
    expect(html).toContain('actionButton("Save feedback"');
    expect(html).toContain('actionButton("Cancel"');
    expect(html).toContain('actionButton("Retry feedback"');
    expect(html).toContain('actionButton("Save via Copilot"');
    expect(html).toContain('actionButton("Continue without saving"');
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