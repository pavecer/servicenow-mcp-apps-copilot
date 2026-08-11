import { describe, expect, it } from "vitest";
import { knowledgeDocumentToPlainText, parseKnowledgeDocument } from "../src/utils/knowledgeDocument";

describe("parseKnowledgeDocument", () => {
  it("preserves generic ServiceNow headings, nested lists, emphasis, and code", () => {
    const document = parseKnowledgeDocument([
      '<h1 style="color:red">Security standard</h1>',
      "<h3>Mac</h3>",
      "<ul><li>Install agent<ul><li><strong>Verify</strong> enrollment</li></ul></li></ul>",
      "<p>Run <code>security-check</code> and <em>review</em> results.</p>"
    ].join(""));

    expect(document).toEqual({
      version: 1,
      truncated: false,
      nodes: [
        { type: "element", tag: "h1", children: [{ type: "text", text: "Security standard" }] },
        { type: "element", tag: "h3", children: [{ type: "text", text: "Mac" }] },
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
          { type: "element", tag: "code", children: [{ type: "text", text: "security-check" }] },
          { type: "text", text: " and " },
          { type: "element", tag: "em", children: [{ type: "text", text: "review" }] },
          { type: "text", text: " results." }
        ] }
      ]
    });
  });

  it("drops executable blocks, comments, unknown elements, and every attribute", () => {
    const document = parseKnowledgeDocument(
      '<!-- hidden --><script><h1>bad</h1></script><style>bad{}</style>' +
      '<p onclick="bad()">Safe <a href="javascript:bad()"><strong>link text</strong></a></p><img src="https://tracker.example/pixel.png" onerror="bad()">' +
      '<template><p>hidden</p></template><img src=x onerror=bad()>'
    );

    expect(JSON.stringify(document)).not.toMatch(/script|style|template|onclick|href|javascript|onerror|hidden|bad/);
    expect(document).toMatchObject({ omittedImageCount: 2 });
    expect(document.nodes).toEqual([
      { type: "element", tag: "p", children: [
        { type: "text", text: "Safe " },
        { type: "element", tag: "strong", children: [{ type: "text", text: "link text" }] }
      ] }
    ]);
  });

  it("uses HTML raw-text and implied-close behavior without hiding later content", () => {
    const document = parseKnowledgeDocument(
      '<script>if (a < b) run(); const marker = "<script>";</script/><p>Visible</p>' +
      '<script=invalid>also visible</script=invalid>' +
      '<ul><li><strong>First<li>Second</ul><p>Before<div>Block</div>After'
    );
    expect(document.nodes).toEqual([
      { type: "element", tag: "p", children: [{ type: "text", text: "Visible" }] },
      { type: "text", text: "also visible" },
      { type: "element", tag: "ul", children: [
        { type: "element", tag: "li", children: [
          { type: "element", tag: "strong", children: [{ type: "text", text: "First" }] }
        ] },
        { type: "element", tag: "li", children: [{ type: "text", text: "Second" }] }
      ] },
      { type: "element", tag: "p", children: [{ type: "text", text: "Before" }] },
      { type: "element", tag: "div", children: [{ type: "text", text: "Block" }] },
      { type: "text", text: "After" }
    ]);
    expect(knowledgeDocumentToPlainText(document)).toContain("Visible");
    expect(knowledgeDocumentToPlainText(document)).not.toContain("if (a < b)");
  });

  it("decodes entities once and bounds hostile or malformed input", () => {
    const document = parseKnowledgeDocument(
      `<p>&lt;safe&gt; &amp;lt; &#x2192; &copy; &hellip; &rsquo; &mdash; Caf&eacute; &euro;5 20&deg;</p><ul><li>${"x".repeat(25_000)}<broken`
    );
    const serialized = JSON.stringify(document);
    expect(serialized).toContain("<safe> &lt; → © … ’ — Café €5 20°");
    expect(serialized).not.toContain("<broken");
    expect(document.truncated).toBe(true);
    expect(serialized.length).toBeLessThan(7_000);
  });

  it("does not mark exact output limits as truncated when all input was retained", () => {
    const document = parseKnowledgeDocument("x".repeat(5_000));
    expect(document.truncated).toBe(false);
    expect(document.nodes).toEqual([{ type: "text", text: "x".repeat(5_000) }]);
  });

  it("ignores prototype-like unknown tags without consuming the node budget", () => {
    const document = parseKnowledgeDocument("<constructor>ignored wrapper</constructor><p>Visible</p>");
    expect(document.nodes).toEqual([
      { type: "text", text: "ignored wrapper" },
      { type: "element", tag: "p", children: [{ type: "text", text: "Visible" }] }
    ]);
  });

  it("never emits more than the structured node budget", () => {
    const document = parseKnowledgeDocument(`${"<br>".repeat(749)}x<p>Later</p><img src="after-limit.png">`);
    const countNodes = (nodes: typeof document.nodes): number => nodes.reduce(
      (total, node) => total + 1 + (node.type === "element" ? countNodes(node.children) : 0),
      0
    );
    expect(countNodes(document.nodes)).toBe(750);
    expect(document.truncated).toBe(true);
    expect(JSON.stringify(document)).not.toContain("Later");
    expect(document.omittedImageCount).toBe(1);
  });

  it("caps omitted image counts and ignores images inside executable blocks", () => {
    const document = parseKnowledgeDocument(`<script>${"<img>".repeat(5)}</script>${"<img>".repeat(120)}`);
    expect(document.omittedImageCount).toBe(99);
  });

  it("derives readable headings and list markers from the sanitized tree", () => {
    const document = parseKnowledgeDocument("<h3>Steps</h3><ol>\n<li>First</li>\n<li>Second<ul>\n<li>Nested</li>\n</ul></li>\n</ol>");
    expect(knowledgeDocumentToPlainText(document)).toBe("Steps\n\n1. First\n2. Second\n• Nested");
  });
});