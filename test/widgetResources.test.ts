import { describe, it, expect, beforeAll } from "vitest";
import * as widgets from "../src/ui/widgets";

// Verifies the SEP-1865 widget resource registration. MCP Apps is always on, so
// the widget resources are always registered.

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

describe("registerWidgetResources", () => {
  let resources: FakeRegisteredResource[];

  beforeAll(() => {
    const fake = createFakeServer();
    widgets.registerWidgetResources(fake.server as never);
    resources = fake.resources;
  });

  it("registers exactly eight ui:// widget resources", () => {
    expect(resources).toHaveLength(8);
    expect(resources.map(r => r.uri).sort()).toEqual([
      "ui://servicenow-mcp/cart.html",
      "ui://servicenow-mcp/catalog-browse.html",
      "ui://servicenow-mcp/incident-detail.html",
      "ui://servicenow-mcp/incident-form.html",
      "ui://servicenow-mcp/my-incidents.html",
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
