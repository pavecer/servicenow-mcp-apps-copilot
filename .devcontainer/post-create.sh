#!/usr/bin/env bash
set -euo pipefail

npm ci
sudo npm install --global \
  azure-functions-core-tools@4 \
  azurite@3 \
  @microsoft/m365agentstoolkit-cli

node .devcontainer/scripts/configure-codespaces.mjs
npm run build

cat <<'EOF'

Codespaces toolchain installed.
Run `npm run cloud:check` after configuring Codespaces secrets and signing in to Azure and Microsoft 365.
EOF
