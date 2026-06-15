import axios, { AxiosError, AxiosInstance } from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config";
import { getRequestContext } from "../requestContext";
import { TokenManager } from "../services/tokenManager";
import { getDownstreamTokenForCaller, isOboEnabled } from "../services/oboTokenService";
import { ServiceNowCatalogItem } from "../types/servicenow";

interface ValidationCheck {
  name: string;
  status: "passed" | "failed" | "warning";
  message: string;
  httpStatus?: number;
}

interface ValidationSummary {
  passed: number;
  failed: number;
  warnings: number;
}

function pushCheck(checks: ValidationCheck[], check: ValidationCheck): void {
  checks.push(check);
}

function summarizeChecks(checks: ValidationCheck[]): ValidationSummary {
  return checks.reduce(
    (acc, check) => {
      if (check.status === "passed") {
        acc.passed += 1;
      } else if (check.status === "failed") {
        acc.failed += 1;
      } else {
        acc.warnings += 1;
      }
      return acc;
    },
    { passed: 0, failed: 0, warnings: 0 }
  );
}

function extractAxiosError(err: unknown): { status?: number; message: string } {
  if (!axios.isAxiosError(err)) {
    return {
      message: err instanceof Error ? err.message : "Unknown error"
    };
  }

  const axiosError = err as AxiosError<{ error?: string; error_description?: string; message?: string }>;
  const status = axiosError.response?.status;
  const body = axiosError.response?.data;
  const bodyMessage = body?.error_description || body?.message || body?.error;

  return {
    status,
    message: bodyMessage || axiosError.message
  };
}

function createClient(accessToken: string): AxiosInstance {
  return axios.create({
    baseURL: config.serviceNow.instanceUrl,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
}

export function registerValidateServiceNowConfigurationTool(server: McpServer, tokenManager: TokenManager): void {

  server.tool(
    "validate_servicenow_config",
    [
      "Validate ServiceNow OAuth/token configuration and effective catalog permissions.",
      "This tool checks whether authentication works and whether core Service Catalog APIs are reachable.",
      "By default, if header x-servicenow-access-token is provided, that caller token is used.",
      "Set forceConfiguredCredentials=true to ignore the caller header and validate the configured app credentials (password or client_credentials grant, per SERVICENOW_OAUTH_GRANT_TYPE).",
      "Set probeOrderNow=true only when you explicitly want to test order endpoint access; this may create a request in ServiceNow."
    ].join(" "),
    {
      query: z
        .string()
        .min(1)
        .optional()
        .default("laptop")
        .describe("Search term used for validating catalog listing access"),
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .default(5)
        .describe("Maximum number of items to request during validation"),
      forceConfiguredCredentials: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, ignore x-servicenow-access-token and validate the configured app credentials (password or client_credentials grant)"),
      probeOrderNow: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, call order_now endpoint as an explicit permission probe (can create an order)"),
      orderProbeItemSysId: z
        .string()
        .optional()
        .describe("Catalog item sys_id to use for order probe; if omitted, first search result is used"),
      orderProbeVariables: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Variables payload used for the optional order probe")
    },
    async ({ query, limit, forceConfiguredCredentials, probeOrderNow, orderProbeItemSysId, orderProbeVariables }) => {
      const checks: ValidationCheck[] = [];
      const ctx = getRequestContext();
      const callerToken = ctx?.serviceNowAccessToken;
      const callerEntraToken = ctx?.callerEntraAccessToken;
      const callerOid = ctx?.callerEntraObjectId;

      let accessToken: string;
      let authMode: "caller_token" | "obo" | "configured_credentials";

      try {
        if (!forceConfiguredCredentials && callerToken) {
          accessToken = callerToken;
          authMode = "caller_token";
          pushCheck(checks, {
            name: "auth.token_source",
            status: "passed",
            message: "Using x-servicenow-access-token from request header"
          });
        } else if (!forceConfiguredCredentials && isOboEnabled() && callerEntraToken) {
          accessToken = await getDownstreamTokenForCaller({
            callerAccessToken: callerEntraToken,
            callerObjectId: callerOid
          });
          authMode = "obo";
          pushCheck(checks, {
            name: "auth.obo_exchange",
            status: "passed",
            message: "Successfully exchanged caller Entra token for downstream ServiceNow token via OBO"
          });
        } else {
          accessToken = await tokenManager.getAccessToken();
          authMode = "configured_credentials";
          pushCheck(checks, {
            name: "auth.configured_credentials",
            status: "passed",
            message: "Successfully acquired access token from configured ServiceNow app credentials"
          });
        }
      } catch (err) {
        const details = extractAxiosError(err);
        pushCheck(checks, {
          name: "auth.configured_credentials",
          status: "failed",
          message: `Unable to obtain token: ${details.message}`,
          httpStatus: details.status
        });

        const summary = summarizeChecks(checks);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  authModeTried: forceConfiguredCredentials ? "configured_credentials_forced" : "configured_credentials_or_caller_token",
                  summary,
                  checks,
                  recommendations: [
                    "Verify SERVICENOW_INSTANCE_URL, SERVICENOW_CLIENT_ID, SERVICENOW_CLIENT_SECRET, and SERVICENOW_OAUTH_TOKEN_PATH.",
                    "Confirm the configured OAuth grant (SERVICENOW_OAUTH_GRANT_TYPE) is permitted by the ServiceNow OAuth app."
                  ]
                },
                null,
                2
              )
            }
          ]
        };
      }

      const client = createClient(accessToken);
      let selectedItemSysId: string | undefined = orderProbeItemSysId;
      let foundCount = 0;

      try {
        const searchResponse = await client.get<{ result: ServiceNowCatalogItem[] }>("/api/sn_sc/servicecatalog/items", {
          params: {
            sysparm_text: query,
            sysparm_limit: limit
          }
        });

        const items = searchResponse.data.result || [];
        foundCount = items.length;

        if (!selectedItemSysId && items.length > 0) {
          selectedItemSysId = items[0].sys_id;
        }

        pushCheck(checks, {
          name: "api.catalog.list",
          status: "passed",
          message: `Catalog list call succeeded (found ${items.length} item(s) for query '${query}')`,
          httpStatus: searchResponse.status
        });

        if (items.length === 0) {
          pushCheck(checks, {
            name: "permissions.catalog_visibility",
            status: "warning",
            message: "No catalog items were returned. This can indicate missing catalog visibility permissions or simply no matches for the query."
          });
        }
      } catch (err) {
        const details = extractAxiosError(err);
        pushCheck(checks, {
          name: "api.catalog.list",
          status: "failed",
          message: `Catalog list call failed: ${details.message}`,
          httpStatus: details.status
        });
      }

      if (selectedItemSysId) {
        try {
          const detailResponse = await client.get(
            `/api/sn_sc/servicecatalog/items/${selectedItemSysId}`,
            {
              params: {
                sysparm_expand_variables: "true"
              }
            }
          );

          pushCheck(checks, {
            name: "api.catalog.item_detail",
            status: "passed",
            message: `Catalog item detail call succeeded for sys_id=${selectedItemSysId}`,
            httpStatus: detailResponse.status
          });
        } catch (err) {
          const details = extractAxiosError(err);
          pushCheck(checks, {
            name: "api.catalog.item_detail",
            status: "failed",
            message: `Catalog item detail call failed for sys_id=${selectedItemSysId}: ${details.message}`,
            httpStatus: details.status
          });
        }
      } else {
        pushCheck(checks, {
          name: "api.catalog.item_detail",
          status: "warning",
          message: "Skipped item detail check because no catalog item sys_id was available."
        });
      }

      if (probeOrderNow) {
        if (!selectedItemSysId) {
          pushCheck(checks, {
            name: "api.catalog.order_now",
            status: "failed",
            message: "Order probe requested but no item sys_id available. Provide orderProbeItemSysId or use a query that returns items."
          });
        } else {
          try {
            const orderPayload: Record<string, unknown> = {
              sysparm_quantity: 1,
              variables: orderProbeVariables || {}
            };

            await client.post(`/api/sn_sc/servicecatalog/items/${selectedItemSysId}/order_now`, orderPayload);
            pushCheck(checks, {
              name: "api.catalog.order_now",
              status: "passed",
              message: `order_now call succeeded for sys_id=${selectedItemSysId}. A request may have been created in ServiceNow.`
            });
          } catch (err) {
            const details = extractAxiosError(err);
            pushCheck(checks, {
              name: "api.catalog.order_now",
              status: "failed",
              message: `order_now call failed for sys_id=${selectedItemSysId}: ${details.message}`,
              httpStatus: details.status
            });
          }
        }
      } else {
        pushCheck(checks, {
          name: "api.catalog.order_now",
          status: "warning",
          message: "Order endpoint probe skipped. Set probeOrderNow=true to explicitly validate order_now permission (can create a request)."
        });
      }

      const summary = summarizeChecks(checks);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: summary.failed === 0,
                authModeUsed: authMode,
                searchQuery: query,
                foundCount,
                selectedItemSysId: selectedItemSysId || null,
                summary,
                checks,
                recommendations: [
                  "If list/detail checks fail with 401/403, review OAuth app setup and ServiceNow roles for the effective identity.",
                  "If list succeeds but foundCount is 0, verify catalog/category visibility for the effective identity.",
                  "Use probeOrderNow=true with a controlled test item to verify ordering rights end-to-end."
                ]
              },
              null,
              2
            )
          }
        ]
      };
    }
  );
}