#!/usr/bin/env bash
set -euo pipefail

node .devcontainer/scripts/configure-codespaces.mjs

if ! pgrep -f "[a]zurite" >/dev/null 2>&1; then
  mkdir -p /tmp/azurite
  nohup azurite --silent --location /tmp/azurite --debug /tmp/azurite/debug.log \
    >/tmp/azurite/output.log 2>&1 &
fi
