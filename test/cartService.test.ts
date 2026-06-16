import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceNowClient } from "../src/services/servicenowClient";
import type { TokenManager } from "../src/services/tokenManager";

// Exercises the cart/basket service methods against stubbed ServiceNow REST
// responses captured from a live instance (dev310193). The focus is the
// normalizeCart flattening (bucketed GET shape vs flat add_to_cart shape) and
// the re-fetch / attribution behaviour of each method.

interface StubHttp {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeClient(http: Partial<StubHttp>): ServiceNowClient {
  const tokenManager = {} as TokenManager;
  const client = new ServiceNowClient(tokenManager);
  const stub: StubHttp = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...http
  };
  // getClient() returns the internal httpClient; swap it for our stub.
  (client as unknown as { httpClient: StubHttp }).httpClient = stub;
  return client;
}

// GET /cart — bucketed shape (lines under a recurring-frequency bucket).
const BUCKETED_CART = {
  result: {
    cart_id: "ec59998783b332107505f0b6feaad338",
    subtotal_price: "$4,497.00",
    subtotal_recurring_frequency: "Annually",
    subtotal_recurring_price: "$300.00",
    yearly: {
      frequency_label: "Annually",
      items: [
        {
          cart_item_id: "1be547418325cb547505f0b6feaad377",
          catalog_item_id: "774906834fbb4200086eeed18110c737",
          item_name: "Developer Laptop (Mac)",
          short_description: "Macbook Pro",
          quantity: "3",
          price: "$1,499.00",
          recurring_price: "$100.00",
          recurring_frequency: "Annually",
          variables: { "Eclipse IDE": "true" }
        }
      ]
    }
  }
};

// POST add_to_cart — flat shape.
const FLAT_ADD = {
  result: {
    cart_id: "ec59998783b332107505f0b6feaad338",
    subtotal: "$1,499.00",
    items: [
      {
        catalog_item_id: "774906834fbb4200086eeed18110c737",
        item_name: "Developer Laptop (Mac)",
        quantity: "1",
        price: "$1,499.00",
        cart_item_id: "1be547418325cb547505f0b6feaad377"
      }
    ]
  }
};

const EMPTY_CART = {
  result: {
    cart_id: "ec59998783b332107505f0b6feaad338",
    subtotal_price: "$0.00"
  }
};

describe("ServiceNowClient cart methods", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getCart flattens the bucketed GET shape into normalized lines", async () => {
    const client = makeClient({ get: vi.fn().mockResolvedValue({ data: BUCKETED_CART }) });
    const cart = await client.getCart();

    expect(cart.cartId).toBe("ec59998783b332107505f0b6feaad338");
    expect(cart.subtotalPrice).toBe("$4,497.00");
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({
      cartItemId: "1be547418325cb547505f0b6feaad377",
      catalogItemId: "774906834fbb4200086eeed18110c737",
      name: "Developer Laptop (Mac)",
      quantity: 3,
      recurringFrequency: "Annually"
    });
  });

  it("addToCart posts quantity+variables then re-fetches the full cart", async () => {
    const post = vi.fn().mockResolvedValue({ data: FLAT_ADD });
    const get = vi.fn().mockResolvedValue({ data: BUCKETED_CART });
    const client = makeClient({ post, get });

    const cart = await client.addToCart("774906834fbb4200086eeed18110c737", {
      quantity: 1,
      variables: { "Eclipse IDE": true }
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/sn_sc/servicecatalog/items/774906834fbb4200086eeed18110c737/add_to_cart");
    expect(body).toMatchObject({ sysparm_quantity: "1", variables: { "Eclipse IDE": true } });
    // Re-fetch happened (cart_id present in add response).
    expect(get).toHaveBeenCalledWith("/api/sn_sc/servicecatalog/cart");
    expect(cart.items).toHaveLength(1);
  });

  it("addToCart omits variables when none provided", async () => {
    const post = vi.fn().mockResolvedValue({ data: FLAT_ADD });
    const get = vi.fn().mockResolvedValue({ data: BUCKETED_CART });
    const client = makeClient({ post, get });

    await client.addToCart("itemX", {});
    const [, body] = post.mock.calls[0];
    expect(body).toEqual({ sysparm_quantity: "1" });
  });

  it("updateCartItem PUTs quantity and normalizes the response", async () => {
    const put = vi.fn().mockResolvedValue({ data: BUCKETED_CART });
    const client = makeClient({ put });

    const cart = await client.updateCartItem("1be547418325cb547505f0b6feaad377", { quantity: 3 });
    expect(put).toHaveBeenCalledWith(
      "/api/sn_sc/servicecatalog/cart/1be547418325cb547505f0b6feaad377",
      { sysparm_quantity: "3" }
    );
    expect(cart.items[0].quantity).toBe(3);
  });

  it("removeCartItem DELETEs the line then re-fetches", async () => {
    const del = vi.fn().mockResolvedValue({ status: 204 });
    const get = vi.fn().mockResolvedValue({ data: EMPTY_CART });
    const client = makeClient({ delete: del, get });

    const cart = await client.removeCartItem("line1");
    expect(del).toHaveBeenCalledWith("/api/sn_sc/servicecatalog/cart/line1");
    expect(get).toHaveBeenCalledWith("/api/sn_sc/servicecatalog/cart");
    expect(cart.items).toHaveLength(0);
  });

  it("emptyCart deletes the whole cart by cart_id", async () => {
    const get = vi.fn().mockResolvedValue({ data: BUCKETED_CART });
    const del = vi.fn().mockResolvedValue({ status: 204 });
    const client = makeClient({ get, delete: del });

    const cart = await client.emptyCart();
    expect(del).toHaveBeenCalledWith(
      "/api/sn_sc/servicecatalog/cart/ec59998783b332107505f0b6feaad338/empty"
    );
    expect(cart.items).toHaveLength(0);
  });

  it("emptyCart is a no-op when the cart has no cart_id", async () => {
    const get = vi.fn().mockResolvedValue({ data: { result: {} } });
    const del = vi.fn();
    const client = makeClient({ get, delete: del });

    const cart = await client.emptyCart();
    expect(del).not.toHaveBeenCalled();
    expect(cart.items).toHaveLength(0);
  });

  it("submitCart posts submit_order and returns the created request", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { result: { request_number: "REQ0010118", request_id: "fc3683818325cb547505f0b6feaad35d" } }
    });
    const client = makeClient({ post });

    const res = await client.submitCart();
    expect(post).toHaveBeenCalledWith("/api/sn_sc/servicecatalog/cart/submit_order", {});
    expect(res.result.request_number).toBe("REQ0010118");
    expect(res.result.request_id).toBe("fc3683818325cb547505f0b6feaad35d");
  });
});
