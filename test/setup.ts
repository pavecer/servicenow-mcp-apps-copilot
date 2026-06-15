// Set dummy environment variables BEFORE any source module is imported.
// `src/config.ts` evaluates `getRequiredEnv` at import time, so any test that
// touches a module which transitively imports `config` (most of `src/`) will
// throw without these. Real values are never needed in unit tests because
// network calls are mocked.

process.env.SERVICENOW_INSTANCE_URL ??= "https://test.service-now.com";
process.env.SERVICENOW_CLIENT_ID ??= "test-client-id";
process.env.SERVICENOW_CLIENT_SECRET ??= "test-client-secret";

// Default to "auth disabled" so middleware doesn't 503 in tests that exercise
// the request pipeline. Individual tests that need auth-enforcement override
// this in a `beforeEach`.
process.env.ENTRA_AUTH_DISABLED ??= "true";
