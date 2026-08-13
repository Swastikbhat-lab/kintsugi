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

# --install-agents: ship the observer/healer/critic/verifier subagents into
# the user-level Claude Code agents dir, so the loop can be driven by hand.
# The fleet lives in the skill dir (`agents/`, the skill-only layout) or in
# the engine checkout (`.claude/agents/`, the plugin layout).
if [[ " $* " == *" --install-agents "* ]]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "$here/agents" ]]; then
    AGENT_SRC="$here/agents"
  else
    AGENT_SRC="$(find_engine)/.claude/agents"
  fi
  [[ -f "$AGENT_SRC/kintsugi-observer.md" ]] || { echo "kintsugi: agent definitions not found at $AGENT_SRC" >&2; exit 1; }
  mkdir -p "$HOME/.claude/agents"
  cp "$AGENT_SRC"/kintsugi-*.md "$HOME/.claude/agents/"
  echo "kintsugi: installed the fleet (observer, healer, critic, verifier) → $HOME/.claude/agents/" >&2
  echo "kintsugi: drive it by hand — ask kintsugi-observer to run a check, kintsugi-healer to propose a repair, kintsugi-verifier to apply and prove it." >&2
  exit 0
fi

# --selfcheck: verify the installation end-to-end, writing nothing. Locates
# (or bootstraps) the engine, probes the runtimes the loop depends on, and
# runs the bundled fixture through the real observe→diagnose→repair→verify→
# settle loop in --dry mode. Exits 0 only if the whole chain converges.
if [[ " $* " == *" --selfcheck "* ]]; then
  ENG="$(find_engine)"
  [[ -f "$ENG/fixture/kintsugi.config.json" ]] || { echo "kintsugi: selfcheck FAIL — no fixture in engine checkout; selfcheck needs a full engine clone" >&2; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "kintsugi: selfcheck FAIL — node not found (the npm fixture dry-run needs it)" >&2; exit 1; }
  if [[ ! -d "$ENG/node_modules" ]]; then
    echo "kintsugi: installing engine dependencies (one-time)…" >&2
    npm --prefix "$ENG" install --no-audit --no-fund >/dev/null 2>&1 || npm --prefix "$ENG" install
  fi
  echo "kintsugi: selfcheck — engine: $ENG" >&2
  echo "kintsugi: selfcheck — node: $(node --version)" >&2
  for t in python3 python go cargo rustc; do
    if command -v "$t" >/dev/null 2>&1; then
      echo "kintsugi: selfcheck — $t: present (gated on availability)" >&2
    else
      echo "kintsugi: selfcheck — $t: absent (fine — checks are gated on probes)" >&2
    fi
  done
  echo "kintsugi: selfcheck — running the bundled fixture dry-run (writes nothing)…" >&2
  # The `if` context keeps `set -e` from killing the script on the dry-run's
  # expected non-zero exit — the exit code is captured, not propagated. And
  # the CLI exits 1 whenever findings remain, which in a dry run they always
  # do (nothing is applied). The pass signal is the loop *converging*: the
  # engine boots, the checks run, observe→…→settle completes, and the
  # harness itself never crashed.
  if OUT="$(npm --prefix "$ENG" run --silent cli -- --source "$ENG/fixture" --config "$ENG/fixture/kintsugi.config.json" --dry 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  if printf '%s\n' "$OUT" | grep -q "CONVERGED"; then
    echo "kintsugi: selfcheck PASS — engine boots and the loop converges dry (rc=$RC is expected — findings remain in dry mode)." >&2
    printf '%s\n' "$OUT" | tail -5 | sed 's/^/    /'
    exit 0
  fi
  echo "kintsugi: selfcheck FAIL — the fixture dry-run did not converge (rc=$RC):" >&2
  printf '%s\n' "$OUT" | tail -15 | sed 's/^/    /'
  exit 1
fi

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
