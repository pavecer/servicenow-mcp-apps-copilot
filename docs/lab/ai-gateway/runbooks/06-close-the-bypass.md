# Runbook 06: close the bypass

## D1: prove the bypass

With a tool blocked on the gateway and `REQUIRE_GATEWAY_HEADER=false`:

```powershell
$h = 'scripts/lab/ai-gateway/run-experiments.mjs'
node $h --scenario call --target gateway --no-bearer --tool report_incident --args '{"shortDescription":"[gwlab] D1 via gateway"}' --label D1-gateway-blocked
node $h --scenario call --target direct --tool report_incident --args '{"shortDescription":"[gwlab] D1 bypass"}' --label D1-direct-bypass
```

Lab result: gateway denied, direct created `<incident-2>` as the user.

## D3: option 1, shared header (executed)

1. Gateway backend auth = header `X-Gateway-Key` (runbook 02 section 6).
2. Same value into azd, never printed:

   ```powershell
   $s = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   azd env set GATEWAY_SHARED_SECRET $s -e snowmcp-gwlab; Remove-Variable s
   azd env set REQUIRE_GATEWAY_HEADER true -e snowmcp-gwlab
   azd provision -e snowmcp-gwlab --no-state
   ```

   Bicep stores it as Key Vault secret `lab-gateway-shared-secret`; the
   Function reads it via a Key Vault reference.
3. Expected: direct 403 "Requests must arrive through the governed gateway.",
   gateway 200.
4. Revert: `azd env set REQUIRE_GATEWAY_HEADER false` + provision. The lab is
   left reverted so the direct OBO path keeps working.

Trade-off: with the lock on, the only path is the gateway, which carries no
user identity, so every OBO tool fails.

## D4: option 2, network (not executed)

Function inbound access restrictions / private endpoint plus gateway outbound
VNet integration. Not run: same identity trade-off, and support for AI Gateway
outbound VNet integration was not verified.
