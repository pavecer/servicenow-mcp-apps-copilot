import { ServiceNowClient } from "./servicenowClient";
import { TokenManager } from "./tokenManager";

// Module-level singletons shared across all HTTP triggers (MCP + Catalog REST).
// In the Azure Functions Node.js v4 worker, all functions share one process,
// so a single TokenManager / ServiceNowClient maximizes token-cache reuse and
// HTTPS keep-alive efficiency.
export const sharedTokenManager = new TokenManager();
export const sharedServiceNowClient = new ServiceNowClient(sharedTokenManager);
