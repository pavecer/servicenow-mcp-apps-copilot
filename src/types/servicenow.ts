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
