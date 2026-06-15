import { describe, it, expect } from "vitest";
import {
  buildCatalogItemSelectionAdaptiveCard,
  buildOrderConfirmationAdaptiveCard,
  buildOrderFormAdaptiveCard
} from "../src/utils/adaptiveCards";
import type {
  ServiceNowCatalogItem,
  ServiceNowCatalogItemDetail,
  ServiceNowOrderResult
} from "../src/types/servicenow";

describe("buildCatalogItemSelectionAdaptiveCard", () => {
  it("emits a selectAction with the item sys_id for each item", () => {
    const items: ServiceNowCatalogItem[] = [
      { sys_id: "abc", name: "Laptop" },
      { sys_id: "def", name: "Monitor", short_description: "27&quot; display" }
    ];

    const card = buildCatalogItemSelectionAdaptiveCard(items);

    expect(card.type).toBe("AdaptiveCard");
    const body = card.body as Array<Record<string, unknown>>;
    // header (2) + 2 item containers
    expect(body.length).toBe(4);

    const [, , first, second] = body;
    expect((first.selectAction as Record<string, unknown>).data).toMatchObject({
      action: "select_catalog_item",
      itemSysId: "abc"
    });
    expect((second.selectAction as Record<string, unknown>).data).toMatchObject({
      action: "select_catalog_item",
      itemSysId: "def"
    });

    // HTML entity should have been decoded.
    const secondItems = second.items as Array<Record<string, unknown>>;
    const descriptionBlock = secondItems[1] as Record<string, unknown>;
    expect(descriptionBlock.text).toContain('"');
    expect(descriptionBlock.text).not.toContain("&quot;");
  });

  it("emits explicit Action.Submit buttons per item so Copilot Studio renderers always show a clickable control", () => {
    // Some Copilot Studio renderers (notably the web test pane) silently
    // ignore Container.selectAction — the card looks like static text and
    // the user has no way to pick an item. Top-level actions[] are always
    // rendered as buttons, so verify each item gets one.
    const items: ServiceNowCatalogItem[] = [
      { sys_id: "abc", name: "Loaner Laptop" },
      { sys_id: "def", name: "Standard Monitor" }
    ];
    const card = buildCatalogItemSelectionAdaptiveCard(items);
    const actions = card.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: "Action.Submit",
      title: "Select: Loaner Laptop",
      data: { action: "select_catalog_item", itemSysId: "abc", itemName: "Loaner Laptop" }
    });
    expect(actions[1]).toMatchObject({
      type: "Action.Submit",
      title: "Select: Standard Monitor",
      data: { action: "select_catalog_item", itemSysId: "def" }
    });
  });

  it("truncates long item names in button labels so narrow chat panes stay legible", () => {
    const longName = "Some Extremely Long Catalog Item Name That Wraps Awkwardly In Buttons";
    const items: ServiceNowCatalogItem[] = [{ sys_id: "x", name: longName }];
    const card = buildCatalogItemSelectionAdaptiveCard(items);
    const actions = card.actions as Array<Record<string, unknown>>;
    const title = actions[0].title as string;
    expect(title.length).toBeLessThanOrEqual("Select: ".length + 40);
    expect(title.endsWith("...")).toBe(true);
    // Full name is still preserved in the submit data for the agent.
    expect((actions[0].data as Record<string, unknown>).itemName).toBe(longName);
  });
});

describe("buildOrderFormAdaptiveCard", () => {
  it("renders an Input.Text for a single-line variable and marks mandatory inputs", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item1",
      name: "Item",
      variables: [
        {
          name: "justification",
          label: "Justification",
          type: "1",
          mandatory: true
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.type === "Input.Text") as Record<string, unknown>;

    expect(input).toBeDefined();
    expect(input.id).toBe("justification");
    expect(input.label).toBe("Justification *");
    expect(input.isRequired).toBe(true);
  });

  it("renders Input.ChoiceSet from a string-encoded choices field", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item2",
      name: "Choice item",
      variables: [
        {
          name: "color",
          label: "Color",
          type: "14",
          choices: "Red\nGreen\nBlue"
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const choice = body.find(b => b.type === "Input.ChoiceSet") as Record<string, unknown>;

    expect(choice).toBeDefined();
    expect(choice.id).toBe("color");
    expect(choice.choices).toEqual([
      { title: "Red", value: "Red" },
      { title: "Green", value: "Green" },
      { title: "Blue", value: "Blue" }
    ]);
    expect(choice.isMultiSelect).toBe(false);
  });

  it("attaches a place_order Submit action carrying the itemSysId", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item3",
      name: "Item",
      variables: []
    };

    const card = buildOrderFormAdaptiveCard(item);
    const actions = card.actions as Array<Record<string, unknown>>;
    expect(actions[0]).toMatchObject({
      type: "Action.Submit",
      data: { action: "place_order", itemSysId: "item3" }
    });
  });

  it("does not leak unevaluated GlideScript default values into the rendered input", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item-glide",
      name: "GlideScript default",
      variables: [
        {
          name: "requested_for",
          label: "Requested for",
          type: "31",
          mandatory: true,
          default_value: "javascript:gs.getUserID();"
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.id === "requested_for") as Record<string, unknown>;

    expect(input).toBeDefined();
    // The literal "javascript:..." snippet must never reach the rendered Adaptive Card.
    expect(input.value).not.toBe("javascript:gs.getUserID();");
    expect(typeof input.value === "string" ? (input.value as string) : "").not.toMatch(/^javascript:/i);
    expect(JSON.stringify(card)).not.toContain("javascript:");
  });

  it("preserves a legitimate string default value when it is not GlideScript", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item-default",
      name: "Real default",
      variables: [
        {
          name: "location",
          label: "Location",
          type: "1",
          default_value: "Headquarters"
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.id === "location") as Record<string, unknown>;

    expect(input?.value).toBe("Headquarters");
  });

  it("skips ServiceNow UI macros (friendly_type = 'macro') instead of emitting a stub input", () => {
    // Mirrors Retire Change Template's `button_renderer` variable on
    // the demo ServiceNow instance: friendly_type "macro" / display_type "Custom" / no label.
    // Such variables only render in the native ServiceNow form and have no
    // meaningful Adaptive Card analog.
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "macro-test",
      name: "Item with a macro",
      variables: [
        {
          name: "button_renderer",
          label: "",
          type: 14 as unknown as string,
          friendly_type: "macro",
          display_type: "Custom"
        },
        {
          name: "justification",
          label: "Justification",
          type: 2 as unknown as string,
          mandatory: true
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;

    // The macro renderer must not appear as an input.
    expect(body.find(b => b.id === "button_renderer")).toBeUndefined();
    // The real input is still emitted.
    expect(body.find(b => b.id === "justification")).toBeDefined();
  });

  it("renders ServiceNow email fields (type 26) as Input.Text with style 'Email'", () => {
    // Mirrors the Email Alias catalog item on the demo ServiceNow instance: numeric type 26
    // with friendly_type "email". Adaptive Cards 1.5 surfaces this as
    // style="Email" so mobile clients can render the email keyboard.
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "email-test",
      name: "Email Alias",
      variables: [
        {
          name: "primary_email",
          label: "Primary email",
          type: 26 as unknown as string,
          friendly_type: "email",
          mandatory: true
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.id === "primary_email") as Record<string, unknown>;

    expect(input?.type).toBe("Input.Text");
    expect(input?.style).toBe("Email");
    expect(input?.isRequired).toBe(true);
  });

  it("renders a reference variable as Input.ChoiceSet when referenceChoices are provided", () => {
    // Mirrors the Packaging & Shipping catalog item on the demo ServiceNow instance:
    // `internal_destination` is a reference to cmn_location. With the
    // orchestration layer pre-resolving candidate records, the card
    // becomes a picker rather than a free-text input.
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "ref-test",
      name: "Packaging & Shipping",
      variables: [
        {
          name: "internal_destination",
          label: "Internal destination",
          type: 18 as unknown as string,
          friendly_type: "reference",
          reference: "cmn_location"
        }
      ]
    };
    const referenceChoices = {
      internal_destination: [
        { title: "Headquarters", value: "0000000000000000000000000000aaaa" },
        { title: "Remote Office", value: "0000000000000000000000000000bbbb" }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item, undefined, referenceChoices);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.id === "internal_destination") as Record<string, unknown>;

    expect(input?.type).toBe("Input.ChoiceSet");
    expect(input?.choices).toEqual(referenceChoices.internal_destination);
    expect(input?.style).toBe("compact");
  });

  it("falls back to a free-text Input.Text for reference variables when no choices are resolved", () => {
    // Lookup failure shouldn't break the form: the user can still type a
    // sys_id (or be helped by the agent in conversation).
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "ref-fallback-test",
      name: "Item with unresolved reference",
      variables: [
        {
          name: "requested_for",
          label: "Requested for",
          type: 18 as unknown as string,
          friendly_type: "reference",
          reference: "sys_user"
        }
      ]
    };

    const card = buildOrderFormAdaptiveCard(item);
    const body = card.body as Array<Record<string, unknown>>;
    const input = body.find(b => b.id === "requested_for") as Record<string, unknown>;

    expect(input?.type).toBe("Input.Text");
  });
});

describe("buildOrderConfirmationAdaptiveCard", () => {
  it("builds a deep link into ServiceNow when a request_id is present", () => {
    const result: ServiceNowOrderResult = {
      request_number: "REQ0001234",
      request_id: "abc123",
      sys_id: "abc123"
    };

    const card = buildOrderConfirmationAdaptiveCard(
      result,
      "https://test.service-now.com/"
    );

    const actions = card.actions as Array<Record<string, unknown>> | undefined;
    // The card always contains a link/Action.OpenUrl referencing the request.
    const flattened = JSON.stringify(card);
    expect(flattened).toContain("REQ0001234");
    expect(flattened).toContain("sys_id=abc123");
    expect(flattened).not.toContain("//nav_to.do"); // trailing slash should be stripped
    expect(actions).toBeDefined();
  });

  it("falls back to the bare instance URL when request_id is missing", () => {
    const result: ServiceNowOrderResult = {
      request_number: "REQ0001235"
    };

    const card = buildOrderConfirmationAdaptiveCard(result, "https://test.service-now.com");
    const flattened = JSON.stringify(card);
    expect(flattened).toContain("REQ0001235");
    expect(flattened).not.toContain("sys_id=");
  });
});
