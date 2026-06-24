export interface ServiceNowCatalogItem {
  sys_id: string;
  name: string;
  short_description?: string;
  description?: string;
  picture?: string;
  category?: {
    sys_id?: string;
    title?: string;
    name?: string;
  };
  sc_catalog?: {
    sys_id?: string;
    title?: string;
    name?: string;
  };
}

export interface ServiceNowVariableChoice {
  label: string;
  value: string;
}

export interface ServiceNowVariable {
  name: string;
  label?: string;
  type?: string | number | Record<string, unknown>;
  question_type?: string | number | Record<string, unknown>;
  ui_type?: string | number | Record<string, unknown>;
  field_type?: string | number | Record<string, unknown>;
  mandatory?: boolean;
  default_value?: string;
  instructions?: string;
  help_text?: string;
  hint?: string;
  description?: string;
  visible?: boolean;
  readonly?: boolean;
  choices?: Array<ServiceNowVariableChoice | Record<string, unknown> | string | number> | Record<string, unknown> | string;
  options?: Array<ServiceNowVariableChoice | Record<string, unknown> | string | number> | Record<string, unknown> | string;
  variables?: ServiceNowVariable[];
  children?: ServiceNowVariable[];
  questions?: ServiceNowVariable[];
  fields?: ServiceNowVariable[];
  [key: string]: unknown;
}

export interface ServiceNowCatalogItemDetail extends ServiceNowCatalogItem {
  variables?: ServiceNowVariable[];
}

export interface ServiceNowOrderResult {
  request_number: string;
  request_id?: string;
  sys_id?: string;
  table?: string;
}

export interface RequestedForDiagnostics {
  source: "explicit" | "caller_lookup" | "caller_fallback" | "none";
  explicitRequestedForProvided: boolean;
  resolvedRequestedFor: string | null;
  callerUpn: string | null;
  callerEntraObjectId: string | null;
  callerValues: string[];
  lookupFields: string[];
  matchedLookupField: string | null;
  matchedLookupValue: string | null;
}

export interface ServiceNowPlaceOrderResponse {
  result: ServiceNowOrderResult;
  requestedForDiagnostics: RequestedForDiagnostics;
}

/**
 * A single normalized line in the ServiceNow cart. ServiceNow returns cart
 * lines under recurring-frequency buckets (yearly/monthly/onetime) on GET, and
 * as a flat `items` array on add_to_cart; `normalizeCart` flattens both shapes
 * into this stable form keyed by `cartItemId` (the per-line primary key used by
 * update/remove).
 */
export interface ServiceNowCartItem {
  cartItemId: string;
  catalogItemId?: string;
  name: string;
  quantity: number;
  price?: string;
  recurringPrice?: string;
  recurringFrequency?: string;
  shortDescription?: string;
  variables?: Record<string, unknown>;
}

/** Normalized snapshot of the authenticated user's ServiceNow cart. */
export interface ServiceNowCart {
  cartId?: string;
  subtotalPrice?: string;
  subtotalRecurringPrice?: string;
  subtotalRecurringFrequency?: string;
  items: ServiceNowCartItem[];
}

/** Input for adding a catalog item to the cart (mirrors PlaceOrderInput). */
export interface AddToCartInput {
  quantity?: number;
  variables?: Record<string, string | number | boolean>;
}

/** Result of submitting the cart as a single ServiceNow request. */
export interface ServiceNowSubmitCartResponse {
  result: ServiceNowOrderResult;
  requestedForDiagnostics: RequestedForDiagnostics;
}

// ── Incident management (end-user "report a problem" flow) ──────────────────

/** Input for reporting (creating) a ServiceNow incident as an end user. */
export interface CreateIncidentInput {
  /** One-line summary (incident.short_description). Required. */
  shortDescription: string;
  /** Optional longer description (incident.description). */
  description?: string;
  /** ServiceNow urgency choice value: "1" High, "2" Medium, "3" Low. */
  urgency?: string;
  /** ServiceNow impact choice value: "1" High, "2" Medium, "3" Low. */
  impact?: string;
  /** Optional incident category (e.g. "hardware", "software", "network"). */
  category?: string;
  /**
   * Optional sys_id or email of the caller the incident is for. Defaults to the
   * authenticated end user (resolved to caller_id).
   */
  callerFor?: string;
}

/** Result of creating an incident. */
export interface ServiceNowIncidentResult {
  number: string;
  sys_id: string;
}

/** A single journal (comments / work notes) entry on an incident. */
export interface ServiceNowIncidentComment {
  value: string;
  createdOn: string;
  createdBy: string;
  /** "comments" (customer-visible) or "work_notes" (internal). */
  field: "comments" | "work_notes";
}

/** Metadata for a file attached to an incident (sys_attachment row). */
export interface ServiceNowIncidentAttachment {
  sysId: string;
  fileName: string;
  contentType: string;
  /** Size in bytes as reported by ServiceNow, or empty when unknown. */
  sizeBytes: string;
  /** Platform link to view/download the attachment. */
  downloadLink: string;
}

/** Full detail for a single incident, shaped for the incident-detail widget. */
export interface ServiceNowIncidentDetail {
  incident: Record<string, unknown>;
  comments: ServiceNowIncidentComment[];
  attachments: ServiceNowIncidentAttachment[];
}

/** Input for uploading a file to an incident. */
export interface AddIncidentAttachmentInput {
  fileName: string;
  contentType: string;
  /** Raw file bytes. */
  data: Buffer;
}
