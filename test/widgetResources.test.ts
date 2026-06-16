import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Verifies the SEP-1865 widget resource registration honours the
// MCP_APPS_ENABLED feature flag. We load each flag state once per describe
// block to keep parallel test runs cheap (re-importing the src tree is
// expensive).

interface FakeRegisteredResource {
  name: string;
  uri: string;
  config: Record<string, unknown>;
  read: () => Promise<unknown>;
}

function createFakeServer() {
  const resources: FakeRegisteredResource[] = [];
  return {
    resources,
    server: {
      registerResource: (name: string, uri: string, cfg: Record<string, unknown>, read: () => Promise<unknown>) => {
        resources.push({ name, uri, config: cfg, read });
      }
    }
  };
}

async function loadWidgets(enabled: boolean) {
  process.env.MCP_APPS_ENABLED = enabled ? "true" : "false";
  vi.resetModules();
  return await import("../src/ui/widgets");
}

describe("registerWidgetResources: flag off", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let widgets: typeof import("../src/ui/widgets");

  beforeAll(async () => {
    widgets = await loadWidgets(false);
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("registers no resources", () => {
    const fake = createFakeServer();
    widgets.registerWidgetResources(fake.server as never);
    expect(fake.resources).toHaveLength(0);
  });
});

describe("registerWidgetResources: flag on", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let widgets: typeof import("../src/ui/widgets");
  let resources: FakeRegisteredResource[];

  beforeAll(async () => {
    widgets = await loadWidgets(true);
    const fake = createFakeServer();
    widgets.registerWidgetResources(fake.server as never);
    resources = fake.resources;
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("registers exactly five ui:// widget resources", () => {
    expect(resources).toHaveLength(5);
    expect(resources.map(r => r.uri).sort()).toEqual([
      "ui://servicenow-mcp/cart.html",
      "ui://servicenow-mcp/catalog-browse.html",
      "ui://servicenow-mcp/my-orders.html",
      "ui://servicenow-mcp/order-detail.html",
      "ui://servicenow-mcp/order-form.html"
    ]);
    for (const resource of resources) {
      expect(resource.config.mimeType).toBe("text/html;profile=mcp-app");
    }
  });

  it("read callbacks return HTML with the MCP-Apps mime type", async () => {
    for (const resource of resources) {
      const result = await resource.read() as { contents: Array<{ uri: string; mimeType: string; text: string }> };
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe(resource.uri);
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      expect(content.text.startsWith("<!doctype html>")).toBe(true);
      // self-contained: must not pull external scripts.
      expect(content.text).not.toMatch(/<script[^>]+src=/i);
      expect(content.text).not.toMatch(/<link[^>]+href=/i);
    }
  });

  it("camelCase permission tokens are honoured (clipboardWrite, not clipboard-write)", () => {
    for (const w of widgets.WIDGETS) {
      if (!w.permissions) continue;
      for (const p of w.permissions) {
        expect(["camera", "microphone", "geolocation", "clipboardWrite"]).toContain(p);
      }
    }
  });
});
