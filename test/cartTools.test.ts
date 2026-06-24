import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceNowClient } from "../src/services/servicenowClient";
import * as cart from "../src/tools/cart";
import { getMinimalToolDefinitions } from "../src/tools/index";

interface RegisteredTool {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (
        name: string,
        _desc: string,
        schema: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        tools.push({ name, schema, handler });
      }
    }
  };
}

const SAMPLE_CART = {
  cartId: "cart1",
  subtotalPrice: "$1,499.00",
  items: [
    {
      cartItemId: "line1",
      catalogItemId: "item1",
      name: "Developer Laptop (Mac)",
      quantity: 2,
      price: "$1,499.00",
      shortDescription: "Macbook Pro"
    }
  ]
};

describe("cart tool manifest", () => {
  it("manifest includes the cart + order line-item tools (nineteen total)", () => {
    const names = getMinimalToolDefinitions().map(t => t.name).sort();
    expect(names).toContain("add_to_cart");
    expect(names).toContain("view_cart");
    expect(names).toContain("update_cart_item");
    expect(names).toContain("remove_cart_item");
    expect(names).toContain("submit_cart");
    expect(names).toContain("update_order_item");
    expect(names).toContain("remove_order_item");
    expect(names).toHaveLength(19);
  });

  it("cart tools are decorated with their widget resourceUri", () => {
    const byName = Object.fromEntries(getMinimalToolDefinitions().map(t => [t.name, t]));
    const meta = byName.view_cart._meta as Record<string, unknown> | undefined;
    expect(meta).toBeTruthy();
    expect((meta as Record<string, unknown>)["ui/resourceUri"]).toBe("ui://servicenow-mcp/cart.html");
  });
});

describe("cart tool handlers", () => {
  let fakeClient: ServiceNowClient;
  let addToCart: ReturnType<typeof vi.fn>;
  let getCart: ReturnType<typeof vi.fn>;
  let updateCartItem: ReturnType<typeof vi.fn>;
  let removeCartItem: ReturnType<typeof vi.fn>;
  let submitCart: ReturnType<typeof vi.fn>;
  let getOrderDetail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    addToCart = vi.fn().mockResolvedValue(SAMPLE_CART);
    getCart = vi.fn().mockResolvedValue(SAMPLE_CART);
    updateCartItem = vi.fn().mockResolvedValue(SAMPLE_CART);
    removeCartItem = vi.fn().mockResolvedValue({ cartId: "cart1", items: [] });
    submitCart = vi.fn().mockResolvedValue({
      result: { request_number: "REQ0010118", request_id: "req1" },
      requestedForDiagnostics: {}
    });
    getOrderDetail = vi.fn().mockResolvedValue({ order: { number: "REQ0010118" }, items: [], approvals: [] });
    fakeClient = {
      addToCart,
      getCart,
      updateCartItem,
      removeCartItem,
      submitCart,
      getOrderDetail
    } as unknown as ServiceNowClient;
  });

  it("add_to_cart forwards itemSysId, variables, quantity", async () => {
    const fake = createFakeServer();
    cart.registerAddToCartTool(fake.server as never, fakeClient);
    const tool = fake.tools[0];
    const result = (await tool.handler({
      itemSysId: "item1",
      variables: { color: "black" },
      quantity: 2
    })) as { structuredContent?: Record<string, unknown> };
    expect(addToCart).toHaveBeenCalledWith("item1", { variables: { color: "black" }, quantity: 2 });
    expect(result.structuredContent).toBeTruthy();
    expect((result.structuredContent as { cart: { items: unknown[] } }).cart.items).toHaveLength(1);
  });

  it("view_cart returns structuredContent", async () => {
    const fake = createFakeServer();
    cart.registerViewCartTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({})) as { structuredContent?: Record<string, unknown> };
    expect(getCart).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toBeTruthy();
  });

  it("update_cart_item rejects when neither quantity nor variables provided", async () => {
    const fake = createFakeServer();
    cart.registerUpdateCartItemTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({ cartItemId: "line1" })) as {
      content: Array<{ text: string }>;
    };
    expect(updateCartItem).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
  });

  it("remove_cart_item forwards cartItemId", async () => {
    const fake = createFakeServer();
    cart.registerRemoveCartItemTool(fake.server as never, fakeClient);
    await fake.tools[0].handler({ cartItemId: "line1" });
    expect(removeCartItem).toHaveBeenCalledWith("line1");
  });

  it("submit_cart returns order-detail structuredContent", async () => {
    const fake = createFakeServer();
    cart.registerSubmitCartTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({})) as {
      structuredContent?: { submitted?: boolean; requestNumber?: string };
    };
    expect(submitCart).toHaveBeenCalledTimes(1);
    expect(result.structuredContent?.submitted).toBe(true);
    expect(result.structuredContent?.requestNumber).toBe("REQ0010118");
  });
});
