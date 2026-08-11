#!/usr/bin/env bash
# Run the Kintsugi loop against a repo. Requires the engine to be installed
# (npm install at the repo root).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec npm --prefix "$ROOT" run --silent cli -- "$@"
