import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bicep = fs.readFileSync(
  path.join(process.cwd(), "infra", "main.bicep"),
  "utf8"
);

describe("Azure secret delivery", () => {
  it("keeps Key Vault private and reachable from the Function VNet", () => {
    expect(bicep).toContain("publicNetworkAccess: 'Disabled'");
    expect(bicep).toContain("name: 'privatelink.vaultcore.azure.net'");
    expect(bicep).toContain("resource keyVaultPrivateEndpoint");
    expect(bicep).toContain("privateLinkServiceId: keyVault.id");
    expect(bicep).toContain("'vault'");
    expect(bicep).toContain("resource keyVaultPrivateDnsZoneGroup");
  });

  it("forces fresh secret versions while Function settings follow latest", () => {
    expect(bicep).toContain("param secretVersionRevision string = utcNow('yyyyMMddHHmmss')");
    expect(bicep.match(/contentType: 'mcp-runtime-\$\{secretVersionRevision\}'/g)).toHaveLength(4);
    expect(bicep).not.toContain("properties.secretUriWithVersion");

    for (const secretResource of [
      "serviceNowClientSecretKeyVaultSecret",
      "serviceNowPasswordKeyVaultSecret!",
      "entraClientSecretKeyVaultSecret!",
      "entraDcrRegistrationTokenKeyVaultSecret!"
    ]) {
      expect(bicep).toContain(
        `@Microsoft.KeyVault(SecretUri=\${keyVault.properties.vaultUri}secrets/\${${secretResource}.name})`
      );
    }
  });
});