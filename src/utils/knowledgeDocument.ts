import type {
  KnowledgeContentDocument,
  KnowledgeContentNode,
  KnowledgeContentTag
} from "../types/servicenow";

const MAX_INPUT_LENGTH = 100_000;
const MAX_TEXT_LENGTH = 5_000;
const MAX_NODE_COUNT = 750;

const allowedTags = new Set<KnowledgeContentTag>([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "strong", "em", "code", "pre",
  "blockquote", "br"
]);

const executableTags = new Set(["script", "style", "noscript", "template"]);

interface MutableElementNode {
  type: "element";
  tag: KnowledgeContentTag;
  children: KnowledgeContentNode[];
}

function decodeEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  const named = new Map<string, string>([
    ["amp", "&"], ["apos", "'"], ["bull", "•"], ["copy", "©"],
    ["deg", "°"], ["eacute", "é"], ["egrave", "è"], ["euro", "€"],
    ["hellip", "…"], ["gt", ">"], ["laquo", "«"], ["ldquo", "“"],
    ["lsquo", "‘"], ["lt", "<"], ["mdash", "—"], ["middot", "·"],
    ["nbsp", " "], ["ndash", "–"], ["plusmn", "±"], ["quot", '"'],
    ["raquo", "»"], ["rdquo", "”"], ["reg", "®"], ["rsquo", "’"],
    ["trade", "™"]
  ]);
  if (named.has(normalized)) return named.get(normalized) as string;

  const isHex = normalized.startsWith("#x");
  if (!isHex && !normalized.startsWith("#")) return `&${entity};`;
  const codePoint = Number.parseInt(normalized.slice(isHex ? 2 : 1), isHex ? 16 : 10);
  if (!Number.isFinite(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(codePoint);
}

function decodeText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_, entity: string) => decodeEntity(entity));
}

function findTagEnd(input: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function readTag(value: string): { closing: boolean; name: string; selfClosing: boolean } | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("?")) return undefined;
  const closing = trimmed.startsWith("/");
  const body = closing ? trimmed.slice(1).trimStart() : trimmed;
  const match = /^([a-z][a-z0-9:-]*)(?=\s|\/|$)/i.exec(body);
  if (!match) return undefined;
  return {
    closing,
    name: match[1].toLowerCase(),
    selfClosing: /\/\s*$/.test(body)
  };
}

function canonicalTag(name: string): KnowledgeContentTag | undefined {
  if (name === "b") return "strong";
  if (name === "i") return "em";
  if (name === "kbd") return "code";
  return allowedTags.has(name as KnowledgeContentTag) ? name as KnowledgeContentTag : undefined;
}

function findRawTextClose(input: string, start: number, tagName: string): number {
  const lower = input.toLowerCase();
  const token = `</${tagName}`;
  let candidate = lower.indexOf(token, start);
  while (candidate >= 0) {
    const delimiter = lower[candidate + token.length] ?? "";
    if (!delimiter || /[\s/>]/.test(delimiter)) return candidate;
    candidate = lower.indexOf(token, candidate + token.length);
  }
  return -1;
}

export function parseKnowledgeDocument(rawHtml: string): KnowledgeContentDocument {
  const input = rawHtml.slice(0, MAX_INPUT_LENGTH);
  const root: KnowledgeContentNode[] = [];
  const stack: MutableElementNode[] = [];
  let nodeCount = 0;
  let textLength = 0;
  let truncated = rawHtml.length > input.length;
  let skipTag = "";

  const children = () => stack.length > 0 ? stack[stack.length - 1].children : root;
  const closeTag = (tag: KnowledgeContentTag) => {
    const index = stack.map(node => node.tag).lastIndexOf(tag);
    if (index >= 0) stack.splice(index);
  };
  const closeOpenListItem = () => {
    let listIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].tag === "ul" || stack[index].tag === "ol") {
        listIndex = index;
        break;
      }
    }
    if (listIndex < 0) return;
    const itemOffset = stack.slice(listIndex + 1).map(node => node.tag).lastIndexOf("li");
    if (itemOffset >= 0) stack.splice(listIndex + 1 + itemOffset);
  };
  const appendText = (value: string) => {
    if (!value || nodeCount >= MAX_NODE_COUNT || textLength >= MAX_TEXT_LENGTH) {
      if (value) truncated = true;
      return;
    }
    const decoded = decodeText(value);
    const remaining = MAX_TEXT_LENGTH - textLength;
    const safeText = decoded.slice(0, remaining);
    if (safeText.length < decoded.length) truncated = true;
    if (!safeText) return;
    const target = children();
    const previous = target[target.length - 1];
    if (previous?.type === "text") previous.text += safeText;
    else {
      target.push({ type: "text", text: safeText });
      nodeCount += 1;
    }
    textLength += safeText.length;
  };

  for (let cursor = 0; cursor < input.length;) {
    if (nodeCount >= MAX_NODE_COUNT || textLength >= MAX_TEXT_LENGTH) {
      truncated = true;
      break;
    }
    if (skipTag) {
      const close = findRawTextClose(input, cursor, skipTag);
      if (close < 0) break;
      const end = findTagEnd(input, close);
      if (end < 0) break;
      cursor = end + 1;
      skipTag = "";
      continue;
    }
    const open = input.indexOf("<", cursor);
    if (open < 0) {
      appendText(input.slice(cursor));
      cursor = input.length;
      break;
    }
    appendText(input.slice(cursor, open));
    if (input.startsWith("<!--", open)) {
      const commentEnd = input.indexOf("-->", open + 4);
      cursor = commentEnd < 0 ? input.length : commentEnd + 3;
      continue;
    }
    const end = findTagEnd(input, open);
    if (end < 0) {
      if (!skipTag) appendText(input.slice(open));
      break;
    }
    const parsed = readTag(input.slice(open + 1, end));
    cursor = end + 1;
    if (!parsed) continue;

    if (executableTags.has(parsed.name) && !parsed.closing) {
      skipTag = parsed.name;
      continue;
    }

    const tag = canonicalTag(parsed.name);
    if (!tag) continue;
    if (parsed.closing) {
      closeTag(tag);
      continue;
    }
    if (nodeCount >= MAX_NODE_COUNT) {
      truncated = true;
      break;
    }
    const isHeading = /^h[1-6]$/.test(tag);
    const isBlock = tag === "div" || tag === "p" || tag === "ul" || tag === "ol" || tag === "blockquote" || tag === "pre" || isHeading;
    if (isBlock && stack.some(node => node.tag === "p")) closeTag("p");
    if (isHeading) {
      const openHeading = [...stack].reverse().find(node => /^h[1-6]$/.test(node.tag));
      if (openHeading) closeTag(openHeading.tag);
    }
    if (tag === "li") closeOpenListItem();
    const node: MutableElementNode = { type: "element", tag, children: [] };
    children().push(node);
    nodeCount += 1;
    if (tag !== "br" && !parsed.selfClosing) stack.push(node);
  }

  return { version: 1, nodes: root, truncated };
}

function plainTextForNode(node: KnowledgeContentNode): string {
  if (node.type === "text") return node.text;
  if (node.tag === "br") return "\n";
  if (node.tag === "ul" || node.tag === "ol") {
    let itemNumber = 0;
    const items = node.children.flatMap(child => {
      if (child.type !== "element" || child.tag !== "li") {
        const incidental = plainTextForNode(child).trim();
        return incidental ? [incidental] : [];
      }
      itemNumber += 1;
      const marker = node.tag === "ol" ? `${itemNumber}. ` : "• ";
      return [`${marker}${child.children.map(plainTextForNode).join("").trim()}`];
    });
    return `\n${items.join("\n")}\n`;
  }
  const content = node.children.map(plainTextForNode).join("");
  if (node.tag === "p" || node.tag === "div" || /^h[1-6]$/.test(node.tag) || node.tag === "blockquote" || node.tag === "pre") {
    return `\n${content}\n`;
  }
  return content;
}

export function knowledgeDocumentToPlainText(document: KnowledgeContentDocument): string {
  return document.nodes
    .map(plainTextForNode)
    .join("")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}