// LAB ONLY. Returns a delegated user token for the MCP server API, kept in
// memory only. Two sources:
//   azcli       `az account get-access-token` for the signed-in Azure CLI user
//               (requires Azure CLI to be pre-authorized on the lab server app)
//   devicecode  MSAL device-code sign-in with the lab harness public client
import { execFileSync } from "node:child_process";
import { PublicClientApplication } from "@azure/msal-node";

export async function getUserToken({ source = "azcli", tenantId, serverAppId, harnessClientId }) {
  const scope = `api://${serverAppId}/access_as_user`;
  if (source === "azcli") {
    const out = execFileSync(process.platform === "win32" ? "az.cmd" : "az",
      ["account", "get-access-token", "--scope", scope, "--tenant", tenantId, "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    return JSON.parse(out).accessToken;
  }
  const pca = new PublicClientApplication({ auth: { clientId: harnessClientId, authority: `https://login.microsoftonline.com/${tenantId}` } });
  const result = await pca.acquireTokenByDeviceCode({
    scopes: [scope],
    deviceCodeCallback: r => process.stderr.write(`\n${r.message}\n\n`)
  });
  return result.accessToken;
}

/** Non-PII view of a token for evidence files. */
export function tokenShape(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return { aud: p.aud, appid: p.appid ?? p.azp, idtyp: p.idtyp, scp: p.scp, ver: p.ver, hasUserName: Boolean(p.preferred_username || p.upn) };
  } catch {
    return { malformed: true };
  }
}
