#!/usr/bin/env bash
# Run the Kintsugi loop against any repo, from any working directory.
#
# Two engines:
#   node   — the full TypeScript engine (default): agent graph, watch mode,
#            all languages, model proposer. Needs Node.
#   python — the Python engine: check runner + repair rules for non-Node
#            repos (Python, Go). Auto-selected for Python-only repos; no
#            Node runtime needed at all. Override with KINTSUGI_RUNNER=node|python.
#
# The engine is located in order:
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

# Absolute on POSIX and on Windows drive letters — a `C:/…` path must not
# be mistaken for a relative one (Git Bash would join it under INVOKE_DIR).
is_abs() { [[ "$1" == /* || "$1" =~ ^[A-Za-z]:[/\\] ]]; }

# Resolve --source early so the runner can be chosen from the target repo.
resolve_source() {
  local prev="" src=""
  for a in "$@"; do
    if [[ "$prev" == "--source" && -n "$a" ]]; then src="$a"; fi
    prev="$a"
  done
  if [[ -z "$src" ]]; then
    echo "$INVOKE_DIR"
  elif is_abs "$src"; then
    echo "$src"
  else
    echo "$(cd "$INVOKE_DIR" && pwd)/$src"
  fi
}

is_python_repo() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  # Mixed repos (package.json + pyproject.toml) stay on the Node engine,
  # which speaks both; the Python engine is the non-Node path.
  [[ -f "$d/package.json" ]] && return 1
  for m in pyproject.toml setup.py setup.cfg Pipfile poetry.lock; do
    [[ -f "$d/$m" ]] && return 0
  done
  for r in "$d"/requirements*.txt; do
    [[ -f "$r" ]] && return 0
  done
  return 1
}

SRC="$(resolve_source "$@")"

RUNNER="${KINTSUGI_RUNNER:-}"
if [[ -z "$RUNNER" ]]; then
  if is_python_repo "$SRC" && { command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; }; then
    RUNNER=python
  else
    RUNNER=node
  fi
fi

# Rewrite relative path-bearing flags against the invocation directory, so
# `--source .` means the caller's repo, not the engine's.
args=()
prev=""
for a in "$@"; do
  case "$prev" in
    --source|--config|--state|--llm-mock)
      if is_abs "$a"; then
        args+=("$a")
      else
        args+=("$(cd "$INVOKE_DIR" && pwd)/$a")
      fi
      ;;
    *) args+=("$a") ;;
  esac
  prev="$a"
done

if [[ "$RUNNER" == "python" ]]; then
  ENG="$(find_engine)"
  [[ -d "$ENG/py" ]] || { echo "kintsugi: engine has no Python runner — re-sync the engine" >&2; exit 1; }
  PY="${PYTHON:-}"
  if [[ -z "$PY" ]]; then
    # A real interpreter, not the Windows Store stub: `command -v python`
    # succeeds for the alias that prints "Python was not found" and exits
    # non-zero, so probe each candidate before trusting it.
    for cand in "$(command -v python3 2>/dev/null)" "$(command -v python 2>/dev/null)" "$(command -v py 2>/dev/null)"; do
      if [[ -n "$cand" ]] && "$cand" -c 'import sys' >/dev/null 2>&1; then
        PY="$cand"; break
      fi
    done
  fi
  if [[ -z "$PY" ]]; then
    echo "kintsugi: no usable Python interpreter found for the Python engine" >&2
    exit 1
  fi
  echo "kintsugi: Python engine — no Node runtime needed" >&2
  (cd "$ENG/py" && exec "$PY" -m kintsugi "${args[@]}")
fi

ENGINE="$(find_engine)"
if [[ ! -d "$ENGINE/node_modules" ]]; then
  echo "kintsugi: installing engine dependencies (one-time)…" >&2
  npm --prefix "$ENGINE" install --no-audit --no-fund >/dev/null 2>&1 || npm --prefix "$ENGINE" install
fi

exec npm --prefix "$ENGINE" run --silent cli -- "${args[@]}"
