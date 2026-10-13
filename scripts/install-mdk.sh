#!/usr/bin/env bash
set -euo pipefail

mdk_repo="${1:-${MDK_REPO:-../mdk}}"

if [[ -f "$mdk_repo/backend/core/install-packages.sh" ]]; then
  # The minimum supported revision still ships the upstream core installer.
  (cd "$mdk_repo/backend/core" && ./install-packages.sh)
else
  npm_version="$(npm --version)"
  if [[ "$npm_version" != 11.* ]]; then
    echo 'ERR_MDK_NPM_VERSION: MDK workspace installation requires npm 11.' >&2
    exit 1
  fi
  # MDK >=0.9 installs from the root workspace. The worker runtime is enough
  # for plugin tests and hosting; a Kernel host needs the full root install.
  (cd "$mdk_repo" && npm ci --ignore-scripts --workspace @tetherto/mdk-worker --include-workspace-root=false)
fi
