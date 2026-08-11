#!/usr/bin/env bash
# Run the Kintsugi loop against any repo, from any working directory.
#
# Locates the engine in order:
#   1. $KINTSUGI_ENGINE (an env var pointing at an engine checkout)
#   2. <skill-dir>/engine            (installed layout)
#   3. <skill-dir>/../../..          (engine repo checkout layout)
#   4. ~/.kintsugi/engine            (bootstrapped clone — created on first use)
#
# Relative --source/--config paths are resolved against the *invocation*
# directory, so the skill works no matter where you run it from.
set -euo pipefail

INVOKE_DIR="$(pwd)"

find_engine() {
  if [[ -n "${KINTSUGI_ENGINE:-}" && -f "$KINTSUGI_ENGINE/package.json" ]]; then
    echo "$KINTSUGI_ENGINE"; return
  fi
  local here root eng
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$here/../engine/package.json" && -d "$here/../engine/src" ]]; then
    echo "$(cd "$here/../engine" && pwd)"; return
  fi
  root="$(cd "$here/../../.." && pwd)"
  if [[ -f "$root/package.json" && -d "$root/src" ]]; then
    echo "$root"; return
  fi
  eng="$HOME/.kintsugi/engine"
  if [[ ! -f "$eng/package.json" ]]; then
    echo "kintsugi: bootstrapping the engine at $eng (one-time)…" >&2
    mkdir -p "$HOME/.kintsugi"
    if command -v gh >/dev/null 2>&1; then
      gh repo clone Swastikbhat-lab/kintsugi "$eng" >/dev/null 2>&1 \
        || git clone https://github.com/Swastikbhat-lab/kintsugi.git "$eng" >/dev/null 2>&1
    else
      git clone https://github.com/Swastikbhat-lab/kintsugi.git "$eng" >/dev/null 2>&1
    fi
  fi
  [[ -f "$eng/package.json" ]] || { echo "kintsugi: engine unavailable — clone Swastikbhat-lab/kintsugi to ~/.kintsugi/engine" >&2; exit 1; }
  echo "$eng"
}

ENGINE="$(find_engine)"
if [[ ! -d "$ENGINE/node_modules" ]]; then
  echo "kintsugi: installing engine dependencies (one-time)…" >&2
  npm --prefix "$ENGINE" install --no-audit --no-fund >/dev/null 2>&1 || npm --prefix "$ENGINE" install
fi

# Rewrite relative path-bearing flags against the invocation directory, so
# `--source .` means the caller's repo, not the engine's.
args=()
prev=""
for a in "$@"; do
  case "$prev" in
    --source|--config|--state|--llm-mock)
      case "$a" in
        /*) args+=("$a") ;;
        *)  args+=("$(cd "$INVOKE_DIR" && pwd)/$a") ;;
      esac
      ;;
    *) args+=("$a") ;;
  esac
  prev="$a"
done

exec npm --prefix "$ENGINE" run --silent cli -- "${args[@]}"
