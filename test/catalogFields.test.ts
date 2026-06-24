import { describe, it, expect } from "vitest";
import {
  htmlToPlainText,
  normalizeChoices,
  normalizeVariableType,
  isReferenceVariable,
  isMultiSelectType
} from "../src/utils/catalogFields";
import { buildOrderFormFields } from "../src/tools/getCatalogItemForm";
import type { ServiceNowCatalogItemDetail, ServiceNowVariable } from "../src/types/servicenow";

describe("htmlToPlainText", () => {
  it("decodes HTML entities to their literal characters", () => {
    expect(htmlToPlainText("27&quot; display")).toBe('27" display');
    expect(htmlToPlainText("R&amp;D &lt;tag&gt;")).toBe("R&D <tag>");
  });

  it("strips HTML markup, including malformed/overlapping tags", () => {
    expect(htmlToPlainText("<b>Bold</b> text")).toBe("Bold text");
    expect(htmlToPlainText("<a<b>nested")).toBe("nested");
  });

  it("never leaves an executable script tag in the output", () => {
    const out = htmlToPlainText("<script>alert('x')</script>safe");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</script");
    expect(out).toContain("safe");
  });

  it("converts structural tags into readable line breaks", () => {
    expect(htmlToPlainText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
    expect(htmlToPlainText("<ul><li>A</li><li>B</li></ul>")).toContain("• A");
  });
});

describe("normalizeChoices", () => {
  it("parses a newline-delimited choices string", () => {
    expect(normalizeChoices({ name: "color", choices: "Red\nGreen\nBlue" } as ServiceNowVariable)).toEqual([
      { title: "Red", value: "Red" },
      { title: "Green", value: "Green" },
      { title: "Blue", value: "Blue" }
    ]);
  });

  it("maps an array of {label,value} objects", () => {
    const choices = normalizeChoices({
      name: "carrier",
      choices: [
        { label: "Verizon", value: "vz" },
        { label: "AT&amp;T", value: "att" }
      ]
    } as unknown as ServiceNowVariable);
    expect(choices).toEqual([
      { title: "Verizon", value: "vz" },
      { title: "AT&T", value: "att" }
    ]);
  });
});

describe("variable type classification", () => {
  it("canonicalizes friendly_type values", () => {
    expect(normalizeVariableType({ name: "x", friendly_type: "Multi Line Text" } as ServiceNowVariable)).toBe(
      "multi_line_text"
    );
  });

  it("detects reference variables via the reference slot", () => {
    expect(isReferenceVariable({ name: "u", reference: "sys_user" } as ServiceNowVariable)).toBe(true);
    expect(isReferenceVariable({ name: "t", type: "1" } as ServiceNowVariable)).toBe(false);
  });

  it("flags multi-select ServiceNow types", () => {
    expect(isMultiSelectType("21")).toBe(true);
    expect(isMultiSelectType("14")).toBe(false);
  });
});

describe("buildOrderFormFields", () => {
  it("marks mandatory single-line text fields", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item1",
      name: "Item",
      variables: [
        { name: "justification", label: "Justification", friendly_type: "single_line_text", mandatory: true }
      ]
    };
    const fields = buildOrderFormFields(item);
    const field = fields.find(f => f.name === "justification");
    expect(field).toMatchObject({ name: "justification", label: "Justification", type: "string", required: true });
  });

  it("emits choices from a string-encoded choices field", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "item2",
      name: "Choice item",
      variables: [{ name: "color", label: "Color", type: "14", choices: "Red\nGreen\nBlue" }]
    };
    const field = buildOrderFormFields(item).find(f => f.name === "color");
    expect(field?.choices).toEqual([
      { title: "Red", value: "Red" },
      { title: "Green", value: "Green" },
      { title: "Blue", value: "Blue" }
    ]);
    expect(field?.multiSelect).toBe(false);
  });

  it("uses pre-resolved referenceChoices for reference variables", () => {
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
    const field = buildOrderFormFields(item, referenceChoices).find(f => f.name === "internal_destination");
    expect(field?.choices).toEqual(referenceChoices.internal_destination);
  });

  it("skips ServiceNow UI macros instead of emitting a stub field", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "macro-test",
      name: "Item with a macro",
      variables: [
        { name: "button_renderer", label: "", type: 14 as unknown as string, friendly_type: "macro", display_type: "Custom" },
        { name: "justification", label: "Justification", type: 2 as unknown as string, mandatory: true }
      ]
    };
    const fields = buildOrderFormFields(item);
    expect(fields.find(f => f.name === "button_renderer")).toBeUndefined();
    expect(fields.find(f => f.name === "justification")).toBeDefined();
  });

  it("classifies ServiceNow email fields (friendly_type 'email') as type 'email'", () => {
    const item: ServiceNowCatalogItemDetail = {
      sys_id: "email-test",
      name: "Email Alias",
      variables: [
        { name: "primary_email", label: "Primary email", type: 26 as unknown as string, friendly_type: "email", mandatory: true }
      ]
    };
    const field = buildOrderFormFields(item).find(f => f.name === "primary_email");
    expect(field).toMatchObject({ name: "primary_email", type: "email", required: true });
  });
});
