import type { ServiceNowVariable } from "../types/servicenow";
import {
  collectVariables,
  getVariableLabel,
  isMultiSelectType,
  normalizeChoices,
  normalizeVariableType
} from "./adaptiveCards";

/**
 * Smart prefill engine for ServiceNow catalog item Adaptive Cards.
 *
 * Design rationale
 * ----------------
 * In the MCP architecture the *agent* (the LLM) holds the live conversation
 * with the end user. This MCP server only sees what the agent forwards. We
 * therefore accept two complementary signals from the agent:
 *
 *  1. `prefillHints` — structured key/value pairs the agent has already
 *     extracted from the conversation. This is the high-confidence path.
 *     Keys can be either:
 *       - the ServiceNow variable `name` (exact match), or
 *       - a normalized label keyword (e.g. "color", "storage", "carrier").
 *  2. `userContext` — a free-text summary of the conversation. Used as a
 *     fallback to extract common patterns (color names, storage like "256GB",
 *     carrier names, etc.) for well-known catalog field types.
 *
 * The engine NEVER calls an LLM itself — it is fully deterministic and
 * cheap. All semantic extraction is delegated to the calling agent via
 * `prefillHints`; this module's job is to deterministically MAP those hints
 * onto the actual ServiceNow variable schema and to NORMALIZE values
 * against the real choice list (so e.g. "256" / "256gb" / "256 GB" all
 * collapse to whatever the catalog item's option string actually is).
 */

export interface PrefillInput {
  userContext?: string;
  prefillHints?: Record<string, unknown>;
}

export type PrefillSource =
  | "hint_exact_name"
  | "hint_label_match"
  | "context_choice_match"
  | "context_pattern_match"
  | "context_boolean";

export interface PrefillDiagnostic {
  variableName: string;
  variableLabel: string;
  value: string | number | boolean;
  source: PrefillSource;
  matchedText?: string;
  hintKey?: string;
}

export interface PrefillResult {
  values: Record<string, string | number | boolean>;
  diagnostics: PrefillDiagnostic[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text).split(/\s+/).filter(Boolean));
}

function looksBoolean(type: string): boolean {
  return ["5", "7", "boolean", "checkbox", "check_box", "toggle"].includes(type);
}

function looksNumeric(type: string): boolean {
  return ["3", "4", "integer", "decimal", "number"].includes(type);
}

function looksMultiLine(type: string, variable: ServiceNowVariable): boolean {
  if (["2", "textarea", "multi_line", "multiline", "multi_line_text"].includes(type)) {
    return true;
  }
  const flag = variable.is_multiline ?? variable.multiline ?? variable.multi_line;
  return flag === true || flag === "true";
}

/**
 * Find the catalog choice whose `title` or `value` best matches a free-form
 * candidate string. Used to map "256" -> "256GB", "black" -> "Midnight Black",
 * etc.
 */
function matchChoice(
  candidate: string,
  choices: Array<{ title: string; value: string }>
): { title: string; value: string } | undefined {
  const normalized = tokenize(candidate);
  if (!normalized) {
    return undefined;
  }

  // 1. Exact value or title match (case-insensitive).
  for (const choice of choices) {
    if (
      tokenize(choice.value) === normalized ||
      tokenize(choice.title) === normalized
    ) {
      return choice;
    }
  }

  // 2. Candidate fully appears as a token sequence inside choice title/value.
  for (const choice of choices) {
    const haystack = `${tokenize(choice.title)} ${tokenize(choice.value)}`;
    if (haystack.includes(normalized)) {
      return choice;
    }
  }

  // 3. Choice tokens fully appear in candidate (handles "i want the 256gb one"
  //    being matched against the "256GB" choice).
  const candidateTokens = tokenSet(candidate);
  for (const choice of choices) {
    const choiceTokens = [...tokenSet(choice.title), ...tokenSet(choice.value)];
    if (
      choiceTokens.length > 0 &&
      choiceTokens.every(token => candidateTokens.has(token))
    ) {
      return choice;
    }
  }

  return undefined;
}

/**
 * Catalog vendors frequently use marketing color names ("Midnight",
 * "Starlight", "Graphite") instead of plain color words. When the user (or
 * the agent's hint) uses an everyday color like "black", try a curated set
 * of common synonyms before giving up. This is intentionally conservative:
 * only well-known one-to-one Apple/Samsung/Dell mappings.
 */
const COLOR_SYNONYMS: Record<string, string[]> = {
  black: ["midnight", "graphite", "space gray", "space grey", "jet black", "obsidian", "phantom black"],
  white: ["starlight", "silver", "natural", "pearl", "phantom white"],
  gray: ["graphite", "space gray", "space grey", "silver"],
  grey: ["graphite", "space gray", "space grey", "silver"],
  gold: ["rose gold", "natural", "champagne"],
  silver: ["starlight", "natural", "platinum"]
};

function matchChoiceWithColorSynonyms(
  candidate: string,
  choices: Array<{ title: string; value: string }>
): { title: string; value: string } | undefined {
  const direct = matchChoice(candidate, choices);
  if (direct) return direct;

  const lower = candidate.toLowerCase().trim();
  const synonyms = COLOR_SYNONYMS[lower];
  if (!synonyms) return undefined;

  for (const synonym of synonyms) {
    const hit = matchChoice(synonym, choices);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A choice list that represents a Yes/No question (such as
 * "Is this a replacement for a lost or broken iPhone?").
 */
function isYesNoChoiceSet(choices: Array<{ title: string; value: string }>): boolean {
  if (choices.length < 2 || choices.length > 4) return false;
  const titles = new Set(choices.map(c => tokenize(c.title)));
  return titles.has("yes") && titles.has("no");
}

function pickYesNoChoice(
  answer: boolean,
  choices: Array<{ title: string; value: string }>
): { title: string; value: string } | undefined {
  const wanted = answer ? "yes" : "no";
  return choices.find(c => tokenize(c.title) === wanted || tokenize(c.value) === wanted);
}

/**
 * Match a hint key (provided by the agent) against a variable. We accept
 * either the exact `variable.name` or a normalized label keyword like
 * "color" matching a label "Phone Color".
 */
function hintKeyMatchesVariable(
  hintKey: string,
  variable: ServiceNowVariable
): "hint_exact_name" | "hint_label_match" | undefined {
  if (!hintKey) {
    return undefined;
  }

  if (hintKey === variable.name) {
    return "hint_exact_name";
  }

  const normalizedKey = tokenize(hintKey);
  if (!normalizedKey) {
    return undefined;
  }

  if (tokenize(variable.name) === normalizedKey) {
    return "hint_exact_name";
  }

  const labelTokens = tokenSet(getVariableLabel(variable));
  const keyTokens = normalizedKey.split(/\s+/);
  if (keyTokens.length > 0 && keyTokens.every(token => labelTokens.has(token))) {
    return "hint_label_match";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Free-text pattern extractors (fallback when no structured hint is provided)
// ---------------------------------------------------------------------------

/**
 * Maps a variable label to one or more well-known semantic "kinds" we know
 * how to extract from a free-text user context.
 */
function classifyLabel(label: string): Set<string> {
  const tokens = tokenSet(label);
  const kinds = new Set<string>();

  const has = (...needles: string[]) => needles.some(n => tokens.has(n));

  if (has("color", "colour")) kinds.add("color");
  if (has("storage", "capacity", "memory", "size", "gb", "tb")) kinds.add("storage");
  if (has("carrier", "network", "operator")) kinds.add("carrier");
  if (has("model", "variant", "version")) kinds.add("model");
  if (
    has("justification", "reason", "business") ||
    (tokens.has("why") || tokens.has("purpose"))
  ) {
    kinds.add("justification");
  }
  if (has("quantity", "qty", "count")) kinds.add("quantity");
  // Duration-bearing labels. "How long do you need it for", "Duration",
  // "Loan period", "Length of loan", etc. Detected BEFORE date because
  // these labels also contain "need" / "for" which would otherwise route
  // them to the date extractor.
  if (
    (tokens.has("how") && tokens.has("long")) ||
    has("duration", "period", "length")
  ) {
    kinds.add("duration");
  }
  // Date-bearing labels. "by" is intentionally excluded since "Approved by",
  // "Created by", etc. would otherwise be misclassified as dates.
  if (has("date", "deadline", "needed", "need", "required", "when", "schedule", "due")) {
    kinds.add("date");
  }
  if (has("location", "office", "site", "building", "shipping", "delivery")) {
    kinds.add("location");
  }
  // "Is this a replacement for a lost or broken iPhone?"
  if (has("replacement", "replace", "lost", "broken", "damaged", "stolen")) {
    kinds.add("replacement");
  }

  return kinds;
}

const COLOR_WORDS = [
  "black", "white", "silver", "gold", "blue", "red", "green", "purple",
  "pink", "yellow", "graphite", "midnight", "starlight", "titanium",
  "natural", "desert", "space gray", "space grey", "rose gold"
];

function extractColor(context: string): string | undefined {
  const lower = context.toLowerCase();
  for (const color of COLOR_WORDS) {
    const pattern = new RegExp(`\\b${color}\\b`, "i");
    if (pattern.test(lower)) {
      return color;
    }
  }
  return undefined;
}

function extractStorage(context: string): string | undefined {
  const match = context.match(/\b(\d{2,4})\s*(gb|tb)\b/i);
  if (match) {
    return `${match[1]}${match[2].toUpperCase()}`;
  }
  return undefined;
}

const CARRIER_WORDS = [
  "verizon", "at&t", "att", "t-mobile", "tmobile", "sprint", "vodafone",
  "o2", "ee", "three", "orange", "telefonica", "telekom", "vodafone",
  "rogers", "bell", "telus", "unlocked"
];

function extractCarrier(context: string): string | undefined {
  const lower = context.toLowerCase();
  for (const carrier of CARRIER_WORDS) {
    if (lower.includes(carrier)) {
      return carrier;
    }
  }
  return undefined;
}

function extractModelVariant(context: string): string | undefined {
  // iPhone model variants. Order matters: prefer the more specific match.
  const variants = [
    "pro max", "pro", "plus", "mini", "ultra", "se", "air"
  ];
  const lower = context.toLowerCase();
  for (const v of variants) {
    const pattern = new RegExp(`\\b${v}\\b`, "i");
    if (pattern.test(lower)) {
      return v;
    }
  }
  return undefined;
}

function extractQuantity(context: string): number | undefined {
  const match = context.match(/\b(\d{1,3})\s*(units?|pcs?|pieces?|items?|phones?|devices?)\b/i);
  if (match) {
    const n = Number(match[1]);
    if (n > 0 && n < 1000) return n;
  }
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12
};

/**
 * Extract a duration phrase ("one week", "for 2 weeks", "a couple of days",
 * "1 month") from a free-text context. Returns BOTH a canonical "N unit"
 * string for plain text fields and a list of equivalent candidate strings
 * for matching against a choice list, since ServiceNow catalogs may express
 * the same duration as "1 Week", "7 Days", "5 Business Days", etc.
 */
function extractDuration(
  context: string
): { canonical: string; candidates: string[] } | undefined {
  const lower = context.toLowerCase();

  // "for a couple of days/weeks/months"
  const couple = lower.match(/\b(?:for\s+)?(?:a\s+)?couple\s+(?:of\s+)?(day|days|week|weeks|month|months)\b/);
  if (couple) {
    return buildDurationResult(2, couple[1]);
  }

  // "for one week", "for 2 weeks", "1 week", "a week", "10 business days"
  const m = lower.match(
    /\b(?:for\s+)?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,3})\s+(?:business\s+|working\s+|calendar\s+)?(day|days|week|weeks|month|months)\b/
  );
  if (!m) return undefined;

  const raw = m[1];
  const n = NUMBER_WORDS[raw] ?? Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 365) return undefined;

  return buildDurationResult(n, m[2]);
}

function buildDurationResult(
  n: number,
  rawUnit: string
): { canonical: string; candidates: string[] } {
  const singular = rawUnit.endsWith("s") ? rawUnit.slice(0, -1) : rawUnit;
  const plural = `${singular}s`;
  const unit = n === 1 ? singular : plural;
  const canonical = `${n} ${unit}`;

  const candidates = new Set<string>();
  candidates.add(canonical);
  candidates.add(`${n} ${plural}`);
  candidates.add(`${n} ${singular}`);

  // Cross-unit equivalents — only fire when the conversion is exact, so we
  // never claim "1 month" equals exactly "30 days" if the catalog only
  // offers "1 Month" we still pick that first via the canonical form.
  if (singular === "week") {
    candidates.add(`${n * 7} days`);
    candidates.add(`${n * 7} day`);
  }
  if (singular === "day" && n % 7 === 0) {
    const weeks = n / 7;
    candidates.add(`${weeks} weeks`);
    candidates.add(`${weeks} week`);
  }

  return { canonical, candidates: [...candidates] };
}

function extractDate(context: string, now: Date = new Date()): string | undefined {
  // Precedence is intentional: an *explicit* date (ISO, Month-Day-Year,
  // numeric slash) is almost always the user's intended answer when both an
  // explicit date and a relative phrase appear in the same sentence
  // ("My laptop is in repair starting tomorrow, I need a loaner from
  //  May 25th 2026" — they want May 25, not tomorrow).

  // 1) ISO yyyy-mm-dd anywhere in the context (highest precedence).
  const iso = context.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    return iso[1];
  }

  // 2) "Month Day Year" and "Day Month Year" forms, e.g.
  //    "May 25 2026", "May 25th, 2026", "25 May 2026", "25th May 2026".
  const monthDayYear = context.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i
  );
  if (monthDayYear) {
    const formatted = buildIsoDate(Number(monthDayYear[3]), MONTHS.indexOf(monthDayYear[1].toLowerCase()), Number(monthDayYear[2]));
    if (formatted) return formatted;
  }
  const dayMonthYear = context.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );
  if (dayMonthYear) {
    const formatted = buildIsoDate(Number(dayMonthYear[3]), MONTHS.indexOf(dayMonthYear[2].toLowerCase()), Number(dayMonthYear[1]));
    if (formatted) return formatted;
  }

  // 3) Slash-separated US/EU dates with a 4-digit year, e.g. "5/25/2026" or
  //    "25/05/2026". Single 2-digit-year variants are skipped (too ambiguous).
  const slashUs = context.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashUs) {
    const a = Number(slashUs[1]);
    const b = Number(slashUs[2]);
    const year = Number(slashUs[3]);
    // Prefer MM/DD/YYYY when the first number could be a month; otherwise treat as DD/MM/YYYY.
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      const formatted = buildIsoDate(year, a - 1, b);
      if (formatted) return formatted;
    } else if (b >= 1 && b <= 12 && a >= 1 && a <= 31) {
      const formatted = buildIsoDate(year, b - 1, a);
      if (formatted) return formatted;
    }
  }

  const lower = context.toLowerCase();

  // 4) Relative day-words: today / tomorrow / yesterday.
  if (/\b(today)\b/.test(lower)) {
    return formatIsoDate(now);
  }
  if (/\btomorrow\b/.test(lower)) {
    return formatIsoDate(addDays(now, 1));
  }
  if (/\byesterday\b/.test(lower)) {
    return formatIsoDate(addDays(now, -1));
  }

  // 5) "in N day(s)/week(s)/month(s)" — bounded so we don't pick "in 2026 years".
  const relMatch = lower.match(/\bin\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/);
  if (relMatch) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2];
    if (Number.isFinite(n) && n >= 0 && n < 365) {
      if (unit.startsWith("day")) return formatIsoDate(addDays(now, n));
      if (unit.startsWith("week")) return formatIsoDate(addDays(now, n * 7));
      if (unit.startsWith("month")) return formatIsoDate(addMonths(now, n));
    }
  }

  // 6) "next <weekday>" — picks the next occurrence after `now`.
  const weekdayMatch = lower.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1]);
    if (target >= 0) {
      const offset = ((target - now.getDay() + 7) % 7) || 7;
      return formatIsoDate(addDays(now, offset));
    }
  }

  return undefined;
}

const WEEKDAYS: readonly string[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"
];
const MONTHS: readonly string[] = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildIsoDate(year: number, monthIndex: number, day: number): string | undefined {
  if (!Number.isFinite(year) || !Number.isFinite(day)) return undefined;
  if (monthIndex < 0 || monthIndex > 11) return undefined;
  if (day < 1 || day > 31) return undefined;
  // Validate by reconstructing and comparing — guards against e.g. Feb 30.
  const candidate = new Date(Date.UTC(year, monthIndex, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== monthIndex ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return formatIsoDate(new Date(year, monthIndex, day));
}

/**
 * Infer the answer to a "is this a replacement?" / "is the device lost or
 * broken?" question from a free-text user context.
 *
 *   - "damaged", "broken", "lost", "stolen", "cracked", "not working",
 *     "replacement", "replace" -> Yes
 *   - "new hire", "first phone", "first time", "never had" -> No
 *
 * Returns `undefined` when no clear signal is present so the user is
 * still required to answer the (mandatory) question themselves.
 */
function extractReplacementSignal(context: string): boolean | undefined {
  const lower = context.toLowerCase();
  if (/\b(damaged|damage|broken|broke|cracked|lost|stolen|replacement|replace|not working|stopped working|defective)\b/.test(lower)) {
    return true;
  }
  if (/\b(new hire|first phone|first time|never had|brand new account)\b/.test(lower)) {
    return false;
  }
  return undefined;
}

function extractBoolean(label: string, context: string): boolean | undefined {
  const labelTokens = [...tokenSet(label)].filter(Boolean);
  if (labelTokens.length === 0) {
    return undefined;
  }

  // Search for an affirmative/negative phrase near the label keywords.
  const lower = context.toLowerCase();
  const labelHit = labelTokens.find(token => lower.includes(token));
  if (!labelHit) return undefined;

  // Crude proximity: look in the same sentence.
  const sentences = lower.split(/(?<=[.!?])\s+/);
  const sentence = sentences.find(s => s.includes(labelHit));
  if (!sentence) return undefined;

  if (/\b(yes|yeah|yep|sure|please|need|want|require|include|add)\b/.test(sentence)) {
    return true;
  }
  if (/\b(no|nope|don'?t|do not|without|skip|exclude)\b/.test(sentence)) {
    return false;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computePrefillValues(
  variables: ServiceNowVariable[] | undefined,
  input: PrefillInput
): PrefillResult {
  const flat = collectVariables(variables);
  const values: Record<string, string | number | boolean> = {};
  const diagnostics: PrefillDiagnostic[] = [];

  const hints = input.prefillHints ?? {};
  const context = input.userContext ?? "";

  for (const variable of flat) {
    if (variable.visible === false || variable.readonly === true) {
      continue;
    }

    const type = normalizeVariableType(variable);
    if (
      type === "container_end" || type === "end_split" || type === "split_end" ||
      type === "container_start" || type === "checkbox_container" ||
      type === "11" || type === "label" || type === "label_only" ||
      type === "formatted_text" || type === "html" || type === "rich_text_label"
    ) {
      continue;
    }

    const label = getVariableLabel(variable);
    const choices = normalizeChoices(variable);
    const labelKinds = classifyLabel(label);
    const isColorChoice = choices.length > 0 && labelKinds.has("color");
    const isReplacementYesNo = choices.length > 0
      && labelKinds.has("replacement")
      && isYesNoChoiceSet(choices);

    // ---- 1. Try structured hints first. ----
    let resolved = false;

    for (const [hintKey, hintRawValue] of Object.entries(hints)) {
      if (hintRawValue === undefined || hintRawValue === null || hintRawValue === "") {
        continue;
      }
      const matchKind = hintKeyMatchesVariable(hintKey, variable);
      if (!matchKind) continue;

      const stringified = String(hintRawValue).trim();
      if (!stringified) continue;

      if (choices.length > 0) {
        // Yes/No replacement question: accept boolean-ish hints too.
        if (isReplacementYesNo) {
          const lower = stringified.toLowerCase();
          const truthy = ["true", "yes", "y", "1", "on"].includes(lower) ||
            /\b(damaged|broken|lost|stolen|replacement|replace)\b/.test(lower);
          const falsy = ["false", "no", "n", "0", "off"].includes(lower);
          if (truthy || falsy) {
            const picked = pickYesNoChoice(truthy && !falsy, choices);
            if (picked) {
              values[variable.name] = picked.value;
              diagnostics.push({
                variableName: variable.name,
                variableLabel: label,
                value: picked.value,
                source: matchKind,
                matchedText: stringified,
                hintKey
              });
              resolved = true;
              break;
            }
          }
        }

        const matched = isColorChoice
          ? matchChoiceWithColorSynonyms(stringified, choices)
          : matchChoice(stringified, choices);
        if (matched) {
          const finalValue = isMultiSelectType(type) ? matched.value : matched.value;
          values[variable.name] = finalValue;
          diagnostics.push({
            variableName: variable.name,
            variableLabel: label,
            value: finalValue,
            source: matchKind,
            matchedText: stringified,
            hintKey
          });
          resolved = true;
          break;
        }
        // Hint provided but no matching choice — skip rather than inject
        // a value the user couldn't have picked themselves.
        continue;
      }

      if (looksBoolean(type)) {
        const v = stringified.toLowerCase();
        if (["true", "yes", "y", "1", "on"].includes(v)) {
          values[variable.name] = true;
          diagnostics.push({
            variableName: variable.name, variableLabel: label,
            value: true, source: matchKind, matchedText: stringified, hintKey
          });
          resolved = true;
          break;
        }
        if (["false", "no", "n", "0", "off"].includes(v)) {
          values[variable.name] = false;
          diagnostics.push({
            variableName: variable.name, variableLabel: label,
            value: false, source: matchKind, matchedText: stringified, hintKey
          });
          resolved = true;
          break;
        }
        continue;
      }

      if (looksNumeric(type)) {
        const n = Number(stringified.replace(/[^\d.\-]/g, ""));
        if (!Number.isNaN(n)) {
          values[variable.name] = n;
          diagnostics.push({
            variableName: variable.name, variableLabel: label,
            value: n, source: matchKind, matchedText: stringified, hintKey
          });
          resolved = true;
          break;
        }
        continue;
      }

      // Plain text / multi-line text / date / anything else.
      values[variable.name] = stringified;
      diagnostics.push({
        variableName: variable.name,
        variableLabel: label,
        value: stringified,
        source: matchKind,
        matchedText: stringified,
        hintKey
      });
      resolved = true;
      break;
    }

    if (resolved || !context) continue;

    // ---- 2. Fallback: extract from free-text user context. ----
    const kinds = labelKinds;

    if (choices.length > 0) {
      // Yes/No replacement question: infer from damage/loss keywords in
      // context BEFORE trying a literal title match (the literal words
      // "yes"/"no" rarely appear verbatim in a conversation).
      if (isReplacementYesNo) {
        const signal = extractReplacementSignal(context);
        if (signal !== undefined) {
          const picked = pickYesNoChoice(signal, choices);
          if (picked) {
            values[variable.name] = picked.value;
            diagnostics.push({
              variableName: variable.name,
              variableLabel: label,
              value: picked.value,
              source: "context_pattern_match",
              matchedText: signal ? "replacement signal" : "new-device signal"
            });
            continue;
          }
        }
      }

      // For a choice variable, walk through any choice whose title/value
      // appears verbatim in the user context.
      const lowerContext = context.toLowerCase();
      let bestChoice: { title: string; value: string } | undefined;
      let bestMatchLength = 0;
      for (const choice of choices) {
        const candidates = [choice.title, choice.value].filter(Boolean);
        for (const c of candidates) {
          const needle = c.toLowerCase().trim();
          if (needle.length >= 2 && lowerContext.includes(needle)) {
            if (needle.length > bestMatchLength) {
              bestChoice = choice;
              bestMatchLength = needle.length;
            }
          }
        }
      }

      // Kind-specific fallback extractors that can then be matched against
      // the choice list.
      if (!bestChoice) {
        let extracted: string | undefined;
        if (kinds.has("color")) extracted = extractColor(context);
        else if (kinds.has("storage")) extracted = extractStorage(context);
        else if (kinds.has("carrier")) extracted = extractCarrier(context);
        else if (kinds.has("model")) extracted = extractModelVariant(context);

        if (extracted) {
          bestChoice = isColorChoice
            ? matchChoiceWithColorSynonyms(extracted, choices)
            : matchChoice(extracted, choices);
        }
      }

      // Duration choice dropdowns ("How long do you need it for ?"). The
      // ServiceNow catalog usually exposes a small enum like "1 Day",
      // "1 Week", "2 Weeks", "1 Month". Try each equivalent candidate the
      // duration extractor produced (e.g. for "one week" we'll try
      // "1 week" and "7 days").
      if (!bestChoice && kinds.has("duration")) {
        const duration = extractDuration(context);
        if (duration) {
          for (const candidate of duration.candidates) {
            const hit = matchChoice(candidate, choices);
            if (hit) {
              bestChoice = hit;
              break;
            }
          }
        }
      }

      if (bestChoice) {
        values[variable.name] = bestChoice.value;
        diagnostics.push({
          variableName: variable.name,
          variableLabel: label,
          value: bestChoice.value,
          source: "context_choice_match",
          matchedText: bestChoice.title
        });
      }
      continue;
    }

    if (looksBoolean(type)) {
      const b = extractBoolean(label, context);
      if (b !== undefined) {
        values[variable.name] = b;
        diagnostics.push({
          variableName: variable.name,
          variableLabel: label,
          value: b,
          source: "context_boolean"
        });
      }
      continue;
    }

    if (looksNumeric(type)) {
      if (kinds.has("quantity")) {
        const q = extractQuantity(context);
        if (q !== undefined) {
          values[variable.name] = q;
          diagnostics.push({
            variableName: variable.name,
            variableLabel: label,
            value: q,
            source: "context_pattern_match",
            matchedText: String(q)
          });
        }
      }
      continue;
    }

    // Text-like fields.
    let extracted: string | undefined;
    if (kinds.has("color")) extracted = extractColor(context);
    else if (kinds.has("storage")) extracted = extractStorage(context);
    else if (kinds.has("carrier")) extracted = extractCarrier(context);
    else if (kinds.has("model")) extracted = extractModelVariant(context);
    else if (kinds.has("duration")) extracted = extractDuration(context)?.canonical;
    else if (kinds.has("date")) extracted = extractDate(context);
    else if (kinds.has("justification") && looksMultiLine(type, variable)) {
      // For free-form justification, surface the conversation context
      // verbatim (trimmed) so the user can edit. This is the single case
      // where we put narrative text into the form.
      const trimmed = context.trim();
      if (trimmed) {
        extracted = trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
      }
    }

    if (extracted) {
      values[variable.name] = extracted;
      diagnostics.push({
        variableName: variable.name,
        variableLabel: label,
        value: extracted,
        source: "context_pattern_match",
        matchedText: extracted
      });
    }
  }

  return { values, diagnostics };
}
