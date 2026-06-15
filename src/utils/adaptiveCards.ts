import { ServiceNowCatalogItem, ServiceNowCatalogItemDetail, ServiceNowOrderResult, ServiceNowVariable } from "../types/servicenow";

/**
 * ServiceNow catalog fields may contain HTML markup. Adaptive Card TextBlock
 * does not render raw HTML, so convert it into readable plain text.
 */
function toAdaptiveText(value?: string): string {
  if (!value) {
    return "";
  }

  const decoded = value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  const text = decoded
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n\n")
    .replace(/<\s*\/div\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\s*\/li\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

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

function readBooleanCandidate(candidate: unknown): boolean | undefined {
  if (typeof candidate === "boolean") {
    return candidate;
  }

  if (typeof candidate === "string") {
    const normalized = candidate.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  if (typeof candidate === "number") {
    return candidate !== 0;
  }

  if (candidate && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    return readBooleanCandidate(record.value ?? record.display_value ?? record.displayValue);
  }

  return undefined;
}

export function getVariableLabel(variable: ServiceNowVariable): string {
  return (
    toAdaptiveText(
      readStringFromCandidate(variable.label, ["label", "display_value", "displayValue"])
      ?? readStringFromCandidate(variable, ["label", "question_text", "questionText", "title", "text", "name"])
    )
    || variable.name
  );
}

function getVariableInstructions(variable: ServiceNowVariable): string {
  return toAdaptiveText(
    readStringFromCandidate(
      variable,
      ["instructions", "help_text", "helpText", "hint", "description", "tooltip", "placeholder"]
    )
  );
}

function getVariableDefaultValue(variable: ServiceNowVariable): string {
  const raw = readStringFromCandidate(
    variable,
    ["default_value", "defaultValue", "value", "display_value", "displayValue"]
  ) ?? "";

  // Filter out unevaluated ServiceNow GlideScript snippets (e.g. "javascript:gs.getUserID();").
  // These are server-side expressions intended to be evaluated by ServiceNow before reaching a
  // client; surfacing the raw script as a form value would expose literal JavaScript to the user.
  if (/^\s*javascript\s*:/i.test(raw)) {
    return "";
  }

  return raw;
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
    .map(entry => ({ title: toAdaptiveText(entry) || entry, value: entry }));
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

/**
 * The demo ServiceNow instance (and likely many real instances) often reports
 * date and date/time variables with the misleading combination
 * `type: 6` + `friendly_type: "single_line_text"`. This helper recognizes
 * when a variable is *probably* a date field even though `normalizeVariableType`
 * would otherwise classify it as plain text. We only override when both the
 * numeric type AND the label look date-shaped, to avoid mistaking labels like
 * "What software do you need installed ?" (also `type: 6` on the demo ServiceNow instance) for
 * dates.
 */
function isLikelyDateField(variable: ServiceNowVariable): "date" | "datetime" | undefined {
  const numericType = typeof variable.type === "number"
    ? variable.type
    : Number(typeof variable.type === "string" ? variable.type : NaN);

  if (numericType !== 6 && numericType !== 8) {
    return undefined;
  }

  const label = String(
    readStringFromCandidate(variable, ["label", "question_text", "questionText", "title", "text", "name"]) ?? ""
  ).toLowerCase();

  // Date-bearing labels. Restricted to unambiguous date markers - we don't
  // include "need" / "by" / "required" because labels like "What software do
  // you need installed ?" or "Approved by" would otherwise be misclassified.
  if (/\b(date|deadline|when|schedule|due|expires?|expiry|effective\s+date|delivery\s+date|start\s+date|end\s+date)\b/.test(label)) {
    return numericType === 6 ? "datetime" : "date";
  }

  return undefined;
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
        const title = toAdaptiveText(String(rawTitle)) || String(rawTitle);
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
            title: toAdaptiveText(String(raw)) || String(raw),
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
            title: toAdaptiveText(String(rawTitle)) || String(rawTitle),
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

function isStaticTextType(type: string): boolean {
  return [
    "11",
    "label",
    "label_only",
    "formatted_text",
    "html",
    "rich_text_label",
    "container_start",
    "checkbox_container",
    "begin_split",
    "split"
  ].includes(type);
}

function isContainerEndType(type: string): boolean {
  return ["container_end", "end_split", "split_end"].includes(type);
}

/**
 * ServiceNow renderer types that have no meaningful Adaptive Card analog
 * (UI macros, custom buttons, server-side scripts, attachments handled by
 * the native form). Returning true here causes buildVariableInput to skip
 * the variable entirely instead of emitting a stub Input.Text.
 */
function isUnsupportedRendererType(type: string): boolean {
  return [
    "macro",
    "ui_macro",
    "macro_with_label",
    "custom",
    "break"
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

function isMultilineType(type: string, variable: ServiceNowVariable): boolean {
  if (["2", "textarea", "multi_line", "multiline", "multi_line_text"].includes(type)) {
    return true;
  }

  return readBooleanCandidate(variable.is_multiline)
    ?? readBooleanCandidate(variable.multiline)
    ?? readBooleanCandidate(variable.multi_line)
    ?? false;
}

function isTruthyValue(value: string): boolean {
  return ["true", "1", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function buildChoicePlaceholder(label: string, instructions: string): string {
  if (instructions) {
    return instructions;
  }

  return /^(select|choose)\b/i.test(label) ? label : `Select ${label}`;
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

/**
 * Builds an Adaptive Card that presents a list of catalog items for the user
 * to choose from after a search. Each item is shown with its name, description,
 * category, and catalog, and can be selected by tapping/clicking the item
 * container, which submits the item's sys_id back to the agent so it can
 * proceed to get_catalog_item_form.
 */
export function buildCatalogItemSelectionAdaptiveCard(
  items: ServiceNowCatalogItem[]
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: "Select a Catalog Item",
      size: "Large",
      weight: "Bolder",
      wrap: true
    },
    {
      type: "TextBlock",
      text: "Choose the item that best matches your request:",
      wrap: true,
      spacing: "Small",
      isSubtle: true
    }
  ];

  for (const item of items) {
    const facts: Record<string, string>[] = [];
    const itemName = toAdaptiveText(item.name) || item.name;
    const shortDescription = toAdaptiveText(item.short_description);

    const categoryLabelRaw = item.category?.title ?? item.category?.name;
    const catalogLabelRaw = item.sc_catalog?.title ?? item.sc_catalog?.name;
    const categoryLabel = categoryLabelRaw ? toAdaptiveText(categoryLabelRaw) : undefined;
    const catalogLabel = catalogLabelRaw ? toAdaptiveText(catalogLabelRaw) : undefined;

    if (categoryLabel) {
      facts.push({ title: "Category:", value: categoryLabel });
    }
    if (catalogLabel) {
      facts.push({ title: "Catalog:", value: catalogLabel });
    }

    const container: Record<string, unknown> = {
      type: "Container",
      spacing: "Medium",
      style: "emphasis",
      items: [
        {
          type: "TextBlock",
          text: itemName,
          weight: "Bolder",
          wrap: true
        },
        ...(item.short_description
          ? [
              {
                type: "TextBlock",
                text: shortDescription,
                wrap: true,
                isSubtle: true,
                spacing: "Small"
              }
            ]
          : []),
        ...(facts.length > 0
          ? [{ type: "FactSet", facts, spacing: "Small" }]
          : [])
      ],
      // selectAction lets advanced clients (Teams, Outlook) submit by tapping
      // the whole container. Some Copilot Studio renderers ignore selectAction
      // on Containers, so we ALSO emit an explicit Action.Submit button per
      // item below — that guarantees a visible, clickable affordance.
      selectAction: {
        type: "Action.Submit",
        data: {
          action: "select_catalog_item",
          itemSysId: item.sys_id,
          itemName
        }
      }
    };

    body.push(container);
  }

  // Explicit per-item buttons. Critical for Copilot Studio's web/test pane
  // renderer, which does not always honor Container.selectAction. Truncate
  // long names so the button labels stay legible in narrow chat panes.
  const actions = items.map(item => {
    const itemName = toAdaptiveText(item.name) || item.name;
    const truncated = itemName.length > 40 ? `${itemName.slice(0, 37)}...` : itemName;
    return {
      type: "Action.Submit",
      title: `Select: ${truncated}`,
      data: {
        action: "select_catalog_item",
        itemSysId: item.sys_id,
        itemName
      }
    };
  });

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions
  };
}

/**
 * Maps a ServiceNow variable to an Adaptive Card input element.
 * ServiceNow variable types (numeric strings):
 *  1 = Single-line text, 2 = Multi-line text, 3 = Integer, 4 = Decimal,
 *  5 = Boolean/checkbox, 6 = Date/Time, 7 = Email, 8 = Date,
 *  14 = Select box, 18 = Lookup select, 21 = Multiple choice
 */
function buildVariableInput(
  variable: ServiceNowVariable,
  prefilledValues?: Record<string, string | number | boolean>,
  referenceChoices?: Record<string, Array<{ title: string; value: string }>>
): Record<string, unknown> | null {
  const baseType = normalizeVariableType(variable);
  // ServiceNow's friendly_type often misreports date/date-time variables as
  // "single_line_text". When the numeric type AND label both look date-shaped,
  // promote the variable so the Adaptive Card builder renders Input.Date.
  const dateOverride = isLikelyDateField(variable);
  const type = dateOverride ?? baseType;
  const choices = normalizeChoices(variable);
  const normalizedLabel = getVariableLabel(variable);
  const normalizedInstructions = getVariableInstructions(variable);
  const fallbackDefault = getVariableDefaultValue(variable);
  const prefilledRaw = prefilledValues?.[variable.name];
  const hasPrefill = prefilledRaw !== undefined && prefilledRaw !== null && String(prefilledRaw).length > 0;
  const defaultValue = hasPrefill ? String(prefilledRaw) : fallbackDefault;
  const label = normalizedLabel + (variable.mandatory ? " *" : "");
  const required = variable.mandatory ?? false;

  if (variable.visible === false || isContainerEndType(type) || isUnsupportedRendererType(type)) {
    return null;
  }

  // Reference field. When the orchestration layer has pre-resolved a list
  // of candidate records from the referenced ServiceNow table, render a
  // ChoiceSet so the user picks an existing record (submit value = sys_id).
  // Falls through to the default Input.Text when no choices were resolved,
  // so the form remains usable even if the lookup endpoint failed.
  if (isReferenceVariable(variable)) {
    const resolvedChoices = referenceChoices?.[variable.name];
    if (resolvedChoices && resolvedChoices.length > 0) {
      return {
        type: "Input.ChoiceSet",
        id: variable.name,
        label,
        placeholder: buildChoicePlaceholder(normalizedLabel, normalizedInstructions),
        value: defaultValue,
        choices: resolvedChoices,
        style: "compact",
        isRequired: required
      };
    }
  }

  if (["checkbox_container", "container_start"].includes(type)) {
    if (!normalizedLabel) {
      return null;
    }

    return {
      type: "TextBlock",
      text: normalizedLabel,
      wrap: true,
      spacing: "Medium",
      weight: "Bolder"
    };
  }

  if (isStaticTextType(type)) {
    const staticText = normalizedInstructions || normalizedLabel;
    if (!staticText) {
      return null;
    }

    return {
      type: "TextBlock",
      text: staticText,
      wrap: true,
      spacing: "Small",
      weight: type === "11" || type === "label" || type === "label_only" ? "Bolder" : "Default"
    };
  }

  // Dropdown / select
  if (choices.length > 0 || ["14", "18", "21", "select", "lookup", "choice"].includes(type)) {
    return {
      type: "Input.ChoiceSet",
      id: variable.name,
      label,
      placeholder: buildChoicePlaceholder(normalizedLabel, normalizedInstructions),
      value: defaultValue,
      choices,
      isMultiSelect: isMultiSelectType(type),
      style: isMultiSelectType(type) ? "expanded" : "compact",
      isRequired: required
    };
  }

  // Boolean / checkbox
  if (["5", "7", "boolean", "checkbox", "check_box"].includes(type)) {
    return {
      type: "Input.Toggle",
      id: variable.name,
      title: normalizedInstructions || normalizedLabel,
      value: isTruthyValue(defaultValue) ? "true" : "false",
      valueOn: "true",
      valueOff: "false",
      isRequired: required
    };
  }

  // Date
  if (["8", "date"].includes(type)) {
    return {
      type: "Input.Date",
      id: variable.name,
      label,
      value: defaultValue,
      isRequired: required
    };
  }

  // Date/Time
  if (["6", "datetime"].includes(type)) {
    return {
      type: "Input.Date",
      id: variable.name,
      label,
      value: defaultValue ? defaultValue.split(" ")[0] : "",
      isRequired: required
    };
  }

  // Multi-line text
  if (isMultilineType(type, variable)) {
    return {
      type: "Input.Text",
      id: variable.name,
      label,
      placeholder: normalizedInstructions || `Enter ${normalizedLabel}`,
      value: defaultValue,
      isMultiline: true,
      isRequired: required
    };
  }

  // Number (integer / decimal)
  if (["3", "4"].includes(type)) {
    return {
      type: "Input.Number",
      id: variable.name,
      label,
      placeholder: normalizedInstructions || `Enter ${normalizedLabel}`,
      value: defaultValue ? Number(defaultValue) : undefined,
      isRequired: required
    };
  }

  // Email field. ServiceNow exposes these as numeric type 26 (with
  // friendly_type "email") or as a friendly_type/display_type literal "email".
  if (["26", "email"].includes(type)) {
    return {
      type: "Input.Text",
      id: variable.name,
      label,
      placeholder: normalizedInstructions || `Enter ${normalizedLabel}`,
      value: defaultValue,
      style: "Email",
      isRequired: required
    };
  }

  // Default: single-line text (covers type 1, 7, and any unknown)
  return {
    type: "Input.Text",
    id: variable.name,
    label,
    placeholder: normalizedInstructions || `Enter ${normalizedLabel}`,
    value: defaultValue,
    isRequired: required
  };
}

/**
 * Builds an Adaptive Card that represents the order form for a catalog item.
 * The card contains inputs for each variable and a submit action.
 *
 * `prefilledValues` is an optional map keyed by variable name (the same key
 * `place_order` later expects). When provided, matching inputs are
 * pre-populated and a small notice is shown so the user understands which
 * fields were filled in for them.
 */
export function buildOrderFormAdaptiveCard(
  item: ServiceNowCatalogItemDetail,
  prefilledValues?: Record<string, string | number | boolean>,
  referenceChoices?: Record<string, Array<{ title: string; value: string }>>
): Record<string, unknown> {
  const shortDescription = toAdaptiveText(item.short_description);
  const description = toAdaptiveText(item.description);
  const effectivePrefill = prefilledValues ?? {};
  const prefilledCount = Object.keys(effectivePrefill).length;

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: toAdaptiveText(item.name),
      size: "Large",
      weight: "Bolder",
      wrap: true
    }
  ];

  if (shortDescription) {
    body.push({
      type: "TextBlock",
      text: shortDescription,
      wrap: true,
      spacing: "Small"
    });
  }

  if (description && description !== shortDescription) {
    body.push({
      type: "TextBlock",
      text: description,
      wrap: true,
      isSubtle: true,
      spacing: "Small"
    });
  }

  const variables = collectVariables(item.variables);

  if (prefilledCount > 0) {
    body.push({
      type: "TextBlock",
      text: `✨ ${prefilledCount} field${prefilledCount === 1 ? "" : "s"} prefilled from your conversation. Please review and adjust before submitting.`,
      wrap: true,
      spacing: "Medium",
      color: "Accent",
      isSubtle: false,
      weight: "Bolder"
    });
  }

  if (variables.length > 0) {
    body.push({
      type: "TextBlock",
      text: "Order Details",
      weight: "Bolder",
      spacing: "Medium"
    });

    for (const variable of variables) {
      const input = buildVariableInput(variable, effectivePrefill, referenceChoices);
      if (input) {
        body.push(input);
      }
    }
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Place Order",
        style: "positive",
        data: {
          action: "place_order",
          itemSysId: item.sys_id
        }
      }
    ]
  };
}

/**
 * Builds an Adaptive Card that confirms a placed order.
 * Shows the request number, status, and a link to ServiceNow.
 */
export function buildOrderConfirmationAdaptiveCard(
  result: ServiceNowOrderResult,
  instanceUrl: string
): Record<string, unknown> {
  const requestUrl = result.request_id
    ? `${instanceUrl.replace(/\/$/, "")}/nav_to.do?uri=sc_request.do?sys_id=${result.request_id}`
    : instanceUrl.replace(/\/$/, "");

  const facts: Record<string, string>[] = [
    { title: "Request Number:", value: result.request_number },
    { title: "Status:", value: "Submitted" }
  ];

  if (result.request_id) {
    facts.push({ title: "Request ID:", value: result.request_id });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: "Order Submitted Successfully",
        size: "Large",
        weight: "Bolder",
        color: "Good",
        wrap: true
      },
      {
        type: "FactSet",
        facts
      },
      {
        type: "TextBlock",
        text: "Your request has been submitted to ServiceNow. You can track its status using the link below.",
        wrap: true,
        spacing: "Medium",
        isSubtle: true
      }
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "View Request in ServiceNow",
        url: requestUrl
      }
    ]
  };
}
