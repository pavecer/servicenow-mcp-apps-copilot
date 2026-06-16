import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Asserts the SEP-1865 widget `structuredContent` payload is:
//   (a) gated behind MCP_APPS_ENABLED — flag-off keeps responses
//       byte-identical to the historical Copilot Studio surface
//   (b) when emitted, comfortably under Cowork's 64 KiB inlined-result cap.
//
// We load each flag state once per describe (the src import graph is heavy)
// to avoid disturbing parallel suites with repeated vi.resetModules().

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

// Two results — the single-item case short-circuits straight to the order form
// (no structuredContent), so the catalog-browse structuredContent assertion
// needs two or more matches.
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

async function reload(enabled: boolean) {
  process.env.MCP_APPS_ENABLED = enabled ? "true" : "false";
  vi.resetModules();
  const search = await import("../src/tools/searchCatalogItems");
  const list = await import("../src/tools/listUserOrders");
  return { search, list };
}

describe("structuredContent gating: flag off", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let mods: Awaited<ReturnType<typeof reload>>;

  beforeAll(async () => { mods = await reload(false); });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("search_catalog_items does NOT emit structuredContent", async () => {
    const fake = createFakeServer();
    mods.search.registerSearchCatalogItemsTool(fake.server as never, fakeSearchClient);
    const result = await fake.tools[0].handler({ query: "laptop" }) as Record<string, unknown>;
    expect(result.structuredContent).toBeUndefined();
    // Legacy text payload still carries selectionAdaptiveCard.
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.selectionAdaptiveCard).toBeDefined();
  });

  it("list_user_orders does NOT emit structuredContent", async () => {
    const fake = createFakeServer();
    mods.list.registerListUserOrdersTool(fake.server as never, fakeListClient);
    const result = await fake.tools[0].handler({}) as Record<string, unknown>;
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("structuredContent gating: flag on", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let mods: Awaited<ReturnType<typeof reload>>;

  beforeAll(async () => { mods = await reload(true); });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("search_catalog_items emits compact structuredContent for 2+ matches under 64 KiB", async () => {
    const fake = createFakeServer();
    mods.search.registerSearchCatalogItemsTool(fake.server as never, fakeMultiSearchClient);
    const result = await fake.tools[0].handler({ query: "hardware" }) as Record<string, unknown>;
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect(sc.query).toBe("hardware");
    expect(sc.found).toBe(2);
    expect(JSON.stringify(sc).length).toBeLessThan(64 * 1024);
    expect((result.content as unknown[]).length).toBe(1);
  });

  it("search_catalog_items with a SINGLE match skips the browse widget and directs to the form", async () => {
    const fake = createFakeServer();
    mods.search.registerSearchCatalogItemsTool(fake.server as never, fakeSearchClient);
    const result = await fake.tools[0].handler({ query: "laptop" }) as Record<string, unknown>;
    // No structuredContent -> catalog-browse widget does not mount.
    expect(result.structuredContent).toBeUndefined();
    // Content directs the model straight to get_catalog_item_form with the sys_id.
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("get_catalog_item_form");
    expect(text).toContain("item1");
    expect(text.toLowerCase()).not.toContain("selectable cards");
  });

  it("auto-advances to the sole item whose NAME matches, even with extra loose results", async () => {
    // Mirrors the dev310193 Pixel case: searching for a "white Pixel 4a 256GB"
    // also returns 2 monitors that merely mention "pixel" resolution. Only
    // "Pixel 4a" has a name contained in the query, so we skip the selection.
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
    mods.search.registerSearchCatalogItemsTool(fake.server as never, pixelClient);
    const result = await fake.tools[0].handler({ query: "white Pixel 4a with 256GB storage" }) as Record<string, unknown>;
    // Sole name match -> skip browse, go to the form for Pixel 4a.
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("get_catalog_item_form");
    expect(text).toContain("pix1");
  });

  it("list_user_orders emits compact structuredContent (drops requestItems) under 64 KiB", async () => {
    const fake = createFakeServer();
    mods.list.registerListUserOrdersTool(fake.server as never, fakeListClient);
    const result = await fake.tools[0].handler({}) as Record<string, unknown>;
    const sc = result.structuredContent as { count: number; orders: Array<Record<string, unknown>> };
    expect(sc.count).toBe(25);
    expect(sc.orders).toHaveLength(25);
    expect(sc.orders[0]).not.toHaveProperty("requestItems");
    expect(JSON.stringify(sc).length).toBeLessThan(64 * 1024);
  });
});
