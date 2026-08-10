import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const widgetPath = path.join(
  process.cwd(),
  "src",
  "ui",
  "widgets",
  "src",
  "order-detail.html"
);
const html = fs.readFileSync(widgetPath, "utf8");

class TestElement {
  tagName: string;
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  value = "";
  parent: TestElement | null = null;
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: { preventDefault: () => void }) => void>>();
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get childNodes() { return this.children; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { this.ownText = ""; this.children = []; }

  appendChild(child: TestElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: { preventDefault: () => void }) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ preventDefault() {} });
    }
  }

  focus() {}
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }

  querySelectorAll(selector: string): TestElement[] {
    const selectors = selector.split(",").map(value => value.trim());
    const matches = (element: TestElement) => selectors.some(value => {
      if (value.startsWith(".")) return element.className.split(/\s+/).includes(value.slice(1));
      if (value.startsWith("#")) return element.id === value.slice(1);
      return element.tagName === value.toLowerCase();
    });
    const found: TestElement[] = [];
    const visit = (element: TestElement) => {
      for (const child of element.children) {
        if (matches(child)) found.push(child);
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
  callTool: (name: string, args: Record<string, unknown>) => unknown = () => Promise.resolve({})
) {
  const root = new TestElement("div");
  root.id = "root";
  const document = {
    createElement: (name: string) => new TestElement(name),
    createTextNode: (text: string) => {
      const node = new TestElement("#text");
      node.textContent = text;
      return node;
    },
    getElementById: (id: string) => id === "root" ? root : null
  };
  const sendFollowUp = vi.fn();
  const host = {
    applyTheme: vi.fn(),
    callTool: vi.fn(callTool),
    getData: () => payload,
    markRendered: vi.fn(),
    onData: (callback: (data: Record<string, unknown>) => void) => callback(payload),
    openExternal: vi.fn(),
    sendFollowUp
  };
  const window = { mcpHost: host, open: vi.fn() };
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  new Function("window", "document", html.slice(scriptStart, scriptEnd))(window, document);
  return { root, host, sendFollowUp };
}

function actionCount(root: TestElement): number {
  return root.querySelectorAll("button").length + root.querySelectorAll(".btn-link").length;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)?.map(value => parseInt(value, 16) / 255) ?? [];
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function loadPhaseModel() {
  const start = html.indexOf("  function readStr");
  const end = html.indexOf("\n\n  var root", start);
  if (start < 0 || end < 0) throw new Error("Unable to locate order phase model.");
  const source = html.slice(start, end);
  return new Function(`${source}\nreturn { derivePhase, classifyApprovalState };`)() as {
    derivePhase: (
      order: Record<string, unknown>,
      items: Array<Record<string, unknown>>,
      approvals: Array<Record<string, unknown>>,
      submitted: boolean
    ) => { key: string; title: string; next: string };
    classifyApprovalState: (value: unknown) => string;
  };
}

describe("order-detail MCP App", () => {
  const model = loadPhaseModel();

  it.each([
    ["waiting approval", { state: "Open" }, [], [{ state: "Requested" }], "pending"],
    ["approved queue", { state: "Open" }, [], [{ state: "Approved" }], "approved"],
    ["fulfillment", { state: "Open" }, [{ stage: "Fulfillment" }], [{ state: "Approved" }], "underway"],
    ["complete items", { state: "Open" }, [{ stage: "Complete" }], [{ state: "Approved" }], "complete"],
    ["rejected", { state: "Open" }, [], [{ state: "Rejected" }], "rejected"],
    ["canceled", { state: "Canceled" }, [], [], "canceled"],
    ["submitted", { state: "Open" }, [], [], "submitted"],
    ["unknown open", { state: "Open" }, [], [], "unknown"]
  ])("derives %s phase conservatively", (_name, order, items, approvals, expected) => {
    const submitted = expected === "submitted";
    expect(model.derivePhase(order, items, approvals, submitted).key).toBe(expected);
  });

  it.each(["Incomplete", "Closed Incomplete"])(
    "classifies %s as terminal without completion",
    (state) => {
      expect(model.derivePhase({ state }, [], [], false).key).toBe("closed");
    }
  );

  it("does not misclassify Not approved as complete or approved", () => {
    const phase = model.derivePhase({ state: "Not approved" }, [], [], false);
    expect(phase.key).not.toBe("complete");
    expect(phase.key).not.toBe("approved");
  });

  it("uses display values from ServiceNow choice objects", () => {
    expect(model.derivePhase(
      { state: { value: "1", display_value: "Open" } },
      [{ stage: { value: "delivery", display_value: "Delivery" } }],
      [{ state: { value: "approved", display_value: "Approved" } }],
      false
    ).key).toBe("underway");
  });

  it("keeps the inline surface focused on status and two actions", () => {
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Approval is complete. This request is queued for fulfillment.");
    expect(html).toContain("Request progress");
    expect(html).not.toContain("Post comment");
    expect(html).not.toContain("update_order_item");
    expect(html).not.toContain("remove_order_item");
    expect(html).toContain('body { margin: 0; padding: 24px;');
    expect(html).toContain('width: 100%; overflow-x: hidden;');
    expect(html).toContain('html[data-theme="dark"]');
    expect(html).toContain("<!-- MCP_HOST_BRIDGE -->");
    expect(html).toContain("markRendered");
    expect(html).toContain('approval.can_decide === true');
    expect(html).toContain('role\", \"alert');
    expect(html).toContain('aria-busy');
    expect(html).toContain('status.textContent = "Working..."');
    expect(html).not.toContain('["approved", "underway", "submitted", "unknown"]');
  });

  it("shows the actionable approval even when it is outside the first three rows", () => {
    const approvals = [1, 2, 3, 4].map(index => ({
      sys_id: `approval-${index}`,
      state: "Requested",
      approver: `Manager ${index}`,
      can_decide: index === 4
    }));
    const { root } = mountWidget({
      order: { sys_id: "request-1", number: "REQ001", state: "Open" },
      items: [],
      approvals
    });

    expect(root.textContent).toContain("Manager 4");
    expect(actionCount(root)).toBe(2);
  });

  it("does not expose approval controls without server eligibility", () => {
    const { root } = mountWidget({
      order: { sys_id: "request-1", number: "REQ001", state: "Open" },
      items: [],
      approvals: [{ sys_id: "approval-1", state: "Requested", approver: "Another manager" }]
    });

    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders an initial structured failure as an alert, not an active request", () => {
    const { root } = mountWidget({
      success: false,
      error: "You do not have access to this order."
    });

    const alert = root.querySelector(".notice");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("do not have access");
    expect(root.textContent).not.toContain("Request in progress");
    expect(actionCount(root)).toBe(0);
  });

  it("shows associated validation when rejecting without a reason", () => {
    const { root } = mountWidget({
      order: { sys_id: "request-1", number: "REQ001", state: "Open" },
      items: [],
      approvals: [{ sys_id: "approval-1", state: "Requested", approver: "Manager", can_decide: true }]
    });
    const reject = root.querySelectorAll("button").find(button => button.textContent === "Reject");
    reject?.click();

    const note = root.querySelector("#approval-note");
    expect(note?.getAttribute("aria-invalid")).toBe("true");
    expect(root.textContent).toContain("Enter a reason before rejecting.");
  });

  it("does not duplicate a successful cancellation through chat fallback", async () => {
    const { root, host, sendFollowUp } = mountWidget({
      order: { sys_id: "request-1", number: "REQ001", state: "Open", approval: "Approved" },
      items: [],
      approvals: []
    }, (name) => name === "update_order"
      ? Promise.resolve({ structuredContent: { success: true } })
      : Promise.resolve({ structuredContent: {
        order: { sys_id: "request-1", number: "REQ001", state: "Open", approval: "Approved" },
        items: [],
        approvals: []
      } }));
    root.querySelectorAll("button").find(button => button.textContent === "Request cancellation")?.click();
    root.querySelectorAll("button").find(button => button.textContent === "Send request")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.callTool).toHaveBeenCalledWith("update_order", expect.any(Object));
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("retires approval controls after a recorded decision when refresh is unavailable", async () => {
    const { root, sendFollowUp } = mountWidget({
      order: { sys_id: "request-1", number: "REQ001", state: "Open" },
      items: [],
      approvals: [{ sys_id: "approval-1", state: "Requested", approver: "Manager", can_decide: true }]
    }, () => Promise.resolve({
      structuredContent: {
        success: true,
        approvalRecorded: true,
        approvalSysId: "approval-1",
        decision: "approved"
      }
    }));
    root.querySelectorAll("button").find(button => button.textContent === "Approve")?.click();
    await Promise.resolve();

    expect(root.textContent).toContain("Approval recorded.");
    expect(root.querySelectorAll("button").some(button => button.textContent === "Approve")).toBe(false);
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it.each(["Closed Incomplete", "Closed Skipped", "Unrecognized"])(
    "does not offer cancellation for %s state",
    (state) => {
      const { root } = mountWidget({
        order: { sys_id: "request-1", number: "REQ001", state },
        items: [],
        approvals: []
      });
      expect(root.textContent).not.toContain("Request cancellation");
    }
  );

  it("keeps dark primary and success fills above normal-text contrast", () => {
    expect(contrastRatio("#ffffff", "#0f6cbd")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#0f6c0f")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps light status fills above normal-text contrast", () => {
    expect(contrastRatio("#ffffff", "#107c10")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#8a5700")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#c50f1f")).toBeGreaterThanOrEqual(4.5);
  });

  it("contains syntactically valid inline JavaScript", () => {
    const scriptStart = html.indexOf("<script>") + "<script>".length;
    const scriptEnd = html.lastIndexOf("</script>");
    expect(scriptStart).toBeGreaterThan("<script>".length - 1);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    expect(() => new Function(html.slice(scriptStart, scriptEnd))).not.toThrow();
  });
});