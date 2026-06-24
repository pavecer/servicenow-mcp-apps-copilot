import { ServiceNowVariable } from "../types/servicenow";

/**
 * ServiceNow catalog fields may contain HTML markup. The MCP Apps widgets
 * render plain text, so convert any HTML into readable plain text before it
 * reaches the widget's structuredContent.
 */
export function htmlToPlainText(value?: string): string {
  if (!value) {
    return "";
  }

  // Strip HTML BEFORE decoding entities so that decoded characters (e.g. an
  // entity-encoded "<") can never re-introduce a tag. First convert structural
  // tags into whitespace/markers, then remove every remaining tag in a loop so
  // malformed/overlapping tags (e.g. "<a<b>") cannot survive a single pass.
  let stripped = value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n\n")
    .replace(/<\s*\/div\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\s*\/li\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, "\n");

  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]*>/g, "");
  } while (stripped !== previous);

  // Decode entities only after all markup is gone. Decode "&amp;" LAST so an
  // input like "&amp;lt;" resolves to the literal "&lt;" rather than "<".
  const text = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");

  const normalized = text
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized;
}

function readStringFromCandidate(
  candidate: unknown,
  keys: string[],
  depth = 0
): string | undefined {
  if (candidate === undefined || candidate === null || depth > 2) {
    return undefined;
  }

  if (typeof candidate === "string" || typeof candidate === "number") {
    const value = String(candidate).trim();
    return value ? value : undefined;
  }

  if (typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  for (const key of keys) {
    const value = readStringFromCandidate(record[key], keys, depth + 1);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function getVariableLabel(variable: ServiceNowVariable): string {
  return (
    htmlToPlainText(
      readStringFromCandidate(variable.label, ["label", "display_value", "displayValue"])
      ?? readStringFromCandidate(variable, ["label", "question_text", "questionText", "title", "text", "name"])
    )
    || variable.name
  );
}

function parseChoiceString(rawChoices: string): Array<{ title: string; value: string }> {
  const trimmed = rawChoices.trim();
  if (!trimmed) {
    return [];
  }

  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return normalizeChoices({ choices: JSON.parse(trimmed) } as ServiceNowVariable);
    } catch {
      // Fall through to line parsing.
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => ({ title: htmlToPlainText(entry) || entry, value: entry }));
}

function getRawChoices(variable: ServiceNowVariable): unknown {
  return variable.choices
    ?? variable.options
    ?? variable.choice_list
    ?? variable.choiceList
    ?? variable.question_choices
    ?? variable.questionChoices
    ?? variable.select_options
    ?? variable.selectOptions;
}

function canonicalizeVariableType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_");
}

export function normalizeVariableType(variable: ServiceNowVariable): string {
  const candidates = [
    variable.friendly_type,
    variable.display_type,
    variable.containerType,
    variable.type,
    variable.question_type,
    variable.ui_type,
    variable.field_type,
    variable.render_type,
    variable.variable_type,
    variable.catalog_type
  ];

  for (const candidate of candidates) {
    const normalized = readStringFromCandidate(candidate, ["value", "name", "type", "display_value", "displayValue"]);
    if (normalized) {
      return canonicalizeVariableType(normalized);
    }
  }

  return "1";
}

export function normalizeChoices(variable: ServiceNowVariable): Array<{ title: string; value: string }> {
  const rawChoices = getRawChoices(variable);
  if (!rawChoices) {
    return [];
  }

  if (typeof rawChoices === "string") {
    return parseChoiceString(rawChoices);
  }

  if (Array.isArray(rawChoices)) {
    return rawChoices
      .map(choice => {
        if (typeof choice === "string" || typeof choice === "number") {
          const value = String(choice);
          return { title: value, value };
        }

        if (!choice || typeof choice !== "object") {
          return null;
        }

        const entry = choice as unknown as Record<string, unknown>;
        const rawValue = entry.value ?? entry.name ?? entry.id;
        const rawTitle = entry.label ?? entry.title ?? entry.text ?? rawValue;

        if (rawValue === undefined || rawValue === null || rawTitle === undefined || rawTitle === null) {
          return null;
        }

        const value = String(rawValue);
        const title = htmlToPlainText(String(rawTitle)) || String(rawTitle);
        return { title, value };
      })
      .filter((choice): choice is { title: string; value: string } => Boolean(choice));
  }

  if (typeof rawChoices === "object") {
    const entries = Object.entries(rawChoices as Record<string, unknown>);
    return entries
      .map(([key, raw]) => {
        if (raw === undefined || raw === null) {
          return null;
        }

        if (typeof raw === "string" || typeof raw === "number") {
          return {
            title: htmlToPlainText(String(raw)) || String(raw),
            value: key
          };
        }

        if (typeof raw === "object") {
          const entry = raw as Record<string, unknown>;
          const rawValue = entry.value ?? key;
          const rawTitle = entry.label ?? entry.title ?? entry.text ?? rawValue;
          if (rawValue === undefined || rawValue === null || rawTitle === undefined || rawTitle === null) {
            return null;
          }
          return {
            title: htmlToPlainText(String(rawTitle)) || String(rawTitle),
            value: String(rawValue)
          };
        }

        return null;
      })
      .filter((choice): choice is { title: string; value: string } => Boolean(choice));
  }

  return [];
}

export function isMultiSelectType(type: string): boolean {
  return [
    "21",
    "33",
    "checkbox",
    "checkboxes",
    "check_box",
    "multi_select",
    "multi-select"
  ].includes(type);
}

/**
 * True when the variable points at another ServiceNow table (lookup /
 * reference field). Detected via either a non-empty `reference` slot on
 * the variable definition, or a friendly_type/canonical type that signals
 * a reference picker. Distinct from "choice" fields, which carry their
 * own static option list.
 */
export function isReferenceVariable(variable: ServiceNowVariable): boolean {
  if (typeof variable.reference === "string" && variable.reference.trim().length > 0) {
    return true;
  }
  const type = normalizeVariableType(variable);
  return ["reference", "lookup_unique_value"].includes(type);
}

/**
 * Returns the ServiceNow table name a reference variable points at, or
 * the empty string when the variable is not a reference.
 */
export function getReferenceTable(variable: ServiceNowVariable): string {
  if (typeof variable.reference === "string") {
    return variable.reference.trim();
  }
  return "";
}

/**
 * Returns the encoded ServiceNow query carried alongside a reference
 * variable (e.g. `"retired=false^EQ"`), or empty when none is set.
 */
export function getReferenceQualifier(variable: ServiceNowVariable): string {
  if (typeof variable.ref_qualifier === "string") {
    return variable.ref_qualifier.trim();
  }
  if (typeof variable.reference_qual === "string") {
    return variable.reference_qual.trim();
  }
  return "";
}

function looksLikeVariableRecord(value: unknown): value is ServiceNowVariable {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return ["name", "label", "type", "question_type", "ui_type", "field_type"].some(key => key in record);
}

export function collectVariables(variables?: ServiceNowVariable[]): ServiceNowVariable[] {
  if (!variables || variables.length === 0) {
    return [];
  }

  const result: ServiceNowVariable[] = [];
  const seen = new Set<ServiceNowVariable>();

  const visit = (variable: ServiceNowVariable) => {
    if (seen.has(variable)) {
      return;
    }

    seen.add(variable);
    result.push(variable);

    for (const key of ["variables", "children", "questions", "fields"] as const) {
      const nested = variable[key];
      if (!Array.isArray(nested)) {
        continue;
      }

      for (const entry of nested) {
        if (looksLikeVariableRecord(entry)) {
          visit(entry);
        }
      }
    }
  };

  for (const variable of variables) {
    visit(variable);
  }

  return result;
}
