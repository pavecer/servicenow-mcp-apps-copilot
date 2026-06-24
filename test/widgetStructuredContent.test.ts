import { describe, it, expect } from "vitest";
import { registerSearchCatalogItemsTool } from "../src/tools/searchCatalogItems";
import { registerListUserOrdersTool } from "../src/tools/listUserOrders";

// MCP Apps is always on: every widget-backed tool emits compact
// `structuredContent` (comfortably under Cowork's 64 KiB inlined-result cap)
// plus a concise, neutral `content` summary — never a verbose JSON/text blob.

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (name: string, _d: string, _s: Record<string, unknown>, handler: RegisteredTool["handler"]) => {
        tools.push({ name, handler });
      }
    }
  };
}

const fakeSearchClient = {
  searchCatalogItems: async () => [
    {
      sys_id: "item1",
      name: "Test laptop",
      short_description: "A laptop",
      category: { sys_id: "cat1", title: "Hardware", name: "hardware" },
      sc_catalog: { sys_id: "scat1", title: "Service Catalog", name: "service_catalog" }
    }
  ]
} as unknown as import("../src/services/servicenowClient").ServiceNowClient;

const fakeMultiSearchClient = {
  searchCatalogItems: async () => [
    {
      sys_id: "item1",
      name: "Test laptop",
      short_description: "A laptop",
      category: { sys_id: "cat1", title: "Hardware", name: "hardware" },
      sc_catalog: { sys_id: "scat1", title: "Service Catalog", name: "service_catalog" }
    },
    {
      sys_id: "item2",
      name: "Test monitor",
      short_description: "A monitor",
      category: { sys_id: "cat1", title: "Hardware", name: "hardware" },
      sc_catalog: { sys_id: "scat1", title: "Service Catalog", name: "service_catalog" }
    }
  ]
} as unknown as import("../src/services/servicenowClient").ServiceNowClient;

const fakeListClient = {
  listUserOrders: async () => Array.from({ length: 25 }, (_, i) => ({
    sys_id: `sys${i}`,
    number: `REQ000${i}`,
    short_description: `Order ${i}`,
    description: `Long description for order ${i}`,
    state: "open",
    updated_on: "2026-01-01",
    requestItems: []
  }))
} as unknown as import("../src/services/servicenowClient").ServiceNowClient;

describe("widget structuredContent", () => {
  it("search_catalog_items emits compact structuredContent for 2+ matches under 64 KiB", async () => {
    const fake = createFakeServer();
    registerSearchCatalogItemsTool(fake.server as never, fakeMultiSearchClient);
    const result = await fake.tools[0].handler({ query: "hardware" }) as Record<string, unknown>;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect(sc.query).toBe("hardware");
    expect(sc.found).toBe(2);
    expect(JSON.stringify(sc).length).toBeLessThan(64 * 1024);
    expect((result.content as unknown[]).length).toBe(1);
  });

  it("search_catalog_items content is a neutral summary, never an Adaptive Card / JSON blob", async () => {
    const fake = createFakeServer();
    registerSearchCatalogItemsTool(fake.server as never, fakeMultiSearchClient);
    const result = await fake.tools[0].handler({ query: "hardware" }) as Record<string, unknown>;
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("selectionAdaptiveCard");
    expect(text).not.toContain("AdaptiveCard");
    // Plain neutral summary, not a JSON document.
    expect(() => JSON.parse(text)).toThrow();
  });

  it("search_catalog_items with a SINGLE match collapses to one auto-select card (neutral content)", async () => {
    const fake = createFakeServer();
    registerSearchCatalogItemsTool(fake.server as never, fakeSearchClient);
    const result = await fake.tools[0].handler({ query: "laptop" }) as Record<string, unknown>;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect(sc.found).toBe(1);
    expect(sc.autoSelect).toBe("item1");
    expect((sc.items as Array<{ sys_id: string }>)).toHaveLength(1);
    // Content stays NEUTRAL -> no imperative instructions that trip Prompt Shield.
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text.toLowerCase()).not.toContain("do not show");
    expect(text.toLowerCase()).not.toContain("immediately call");
    expect(text).not.toContain("get_catalog_item_form");
  });

  it("auto-advances to the sole item whose NAME matches, even with extra loose results", async () => {
    const pixelClient = {
      searchCatalogItems: async () => [
        { sys_id: "pix1", name: "Pixel 4a", short_description: "Google phone",
          category: { sys_id: "c", title: "Mobiles", name: "mobiles" },
          sc_catalog: { sys_id: "s", title: "Service Catalog", name: "service_catalog" } },
        { sys_id: "mon27", name: "Standard 27\" Monitor", short_description: "Display",
          category: { sys_id: "c", title: "Peripherals", name: "peripherals" },
          sc_catalog: { sys_id: "s", title: "Service Catalog", name: "service_catalog" } },
        { sys_id: "mon24", name: "Standard 24\" Monitor", short_description: "Display",
          category: { sys_id: "c", title: "Peripherals", name: "peripherals" },
          sc_catalog: { sys_id: "s", title: "Service Catalog", name: "service_catalog" } }
      ]
    } as unknown as import("../src/services/servicenowClient").ServiceNowClient;

    const fake = createFakeServer();
    registerSearchCatalogItemsTool(fake.server as never, pixelClient);
    const result = await fake.tools[0].handler({ query: "white Pixel 4a with 256GB storage" }) as Record<string, unknown>;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect(sc.found).toBe(1);
    expect(sc.autoSelect).toBe("pix1");
    const scItems = sc.items as Array<{ sys_id: string; name: string }>;
    expect(scItems).toHaveLength(1);
    expect(scItems[0].sys_id).toBe("pix1");
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("get_catalog_item_form");
    expect(text.toLowerCase()).not.toContain("immediately call");
  });

  it("list_user_orders emits compact structuredContent (drops requestItems) under 64 KiB", async () => {
    const fake = createFakeServer();
    registerListUserOrdersTool(fake.server as never, fakeListClient);
    const result = await fake.tools[0].handler({}) as Record<string, unknown>;
    const sc = result.structuredContent as { count: number; orders: Array<Record<string, unknown>> };
    expect(sc.count).toBe(25);
    expect(sc.orders).toHaveLength(25);
    expect(sc.orders[0]).not.toHaveProperty("requestItems");
    expect(JSON.stringify(sc).length).toBeLessThan(64 * 1024);
  });
});
