import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOrderFormFields } from "../src/tools/getCatalogItemForm";
import { collectVariables, normalizeVariableType, isReferenceVariable } from "../src/utils/adaptiveCards";
import type { ServiceNowVariable } from "../src/types/servicenow";

interface Fixture {
  name: string;
  variables: ServiceNowVariable[];
}

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "catalogItems.json"), "utf8")
) as Record<string, Fixture>;

describe("order-form field mapping across real ServiceNow items", () => {
  it("reports the field-type mapping for every captured item", () => {
    const lines: string[] = [];
    const typeTotals: Record<string, number> = {};
    let suspiciousStringFields = 0;

    for (const [sysId, item] of Object.entries(fixtures)) {
      const fields = buildOrderFormFields(item);
      lines.push(`\n=== ${item.name} (${sysId.slice(0, 8)}) — ${fields.length} field(s) ===`);

      // Cross-reference raw variables so we can flag mis-classifications.
      const rawByName = new Map<string, ServiceNowVariable>();
      for (const v of collectVariables(item.variables)) {
        if (v.name) rawByName.set(v.name, v);
      }

      for (const f of fields) {
        const name = String(f.name ?? "");
        const type = String(f.type ?? "");
        const choices = Array.isArray(f.choices) ? (f.choices as unknown[]).length : 0;
        typeTotals[type] = (typeTotals[type] ?? 0) + 1;
        const raw = rawByName.get(name);
        const rawType = raw ? normalizeVariableType(raw) : "?";
        const isRef = raw ? isReferenceVariable(raw) : false;

        let flag = "";
        // A plain "string" field that is actually a reference/choice with no
        // resolved options is the realistic gap (reference lookups happen in
        // the tool, not here). Flag it so we can see how many items rely on it.
        if (type === "string" && isRef) {
          flag = "  <-- REFERENCE (free-text offline; tool injects choices)";
          suspiciousStringFields++;
        } else if (type === "string" && ["14", "18", "21", "select", "choice", "lookup"].includes(rawType)) {
          flag = "  <-- CHOICE w/o options";
          suspiciousStringFields++;
        }
        lines.push(
          `  type=${type.padEnd(9)} rawType=${rawType.padEnd(16)} choices=${choices} req=${f.required ?? false}  ${JSON.stringify(f.label)}${flag}`
        );
      }
    }

    lines.push("\n=== TYPE TOTALS ===");
    for (const [t, n] of Object.entries(typeTotals).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${t.padEnd(9)} ${n}`);
    }
    lines.push(`suspicious string fields (reference/choice without options): ${suspiciousStringFields}`);

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    // Guard: no field should be left as an untyped blank — every field must
    // carry one of the known widget types.
    const known = new Set(["string", "longtext", "boolean", "number", "email", "date", "datetime", "label"]);
    for (const item of Object.values(fixtures)) {
      for (const f of buildOrderFormFields(item)) {
        expect(known.has(String(f.type))).toBe(true);
      }
    }
  });
});
