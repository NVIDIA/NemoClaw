#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Documentation checks (default: all):
#   1) Markdown links — local paths exist; optional curl for unique http(s) URLs.
#   2) CLI parity — `nemoclaw --help` vs ### `nemoclaw …` in docs/reference/commands.md.
#
# Usage (from repo root):
#   test/e2e/e2e-cloud-experimental/check-docs.sh                    # both checks
#   test/e2e/e2e-cloud-experimental/check-docs.sh --only-links
#   test/e2e/e2e-cloud-experimental/check-docs.sh --only-cli
#   test/e2e/e2e-cloud-experimental/check-docs.sh --local-only
#   CHECK_DOC_LINKS_REMOTE=0 test/e2e/e2e-cloud-experimental/check-docs.sh
#   test/e2e/e2e-cloud-experimental/check-docs.sh path/to/a.md
#
# Environment:
#   CHECK_DOC_LINKS_REMOTE   If 0, skip http(s) probes for links check.
#   CHECK_DOC_LINKS_VERBOSE  If 1, log each URL during curl (same as --verbose).
#   NODE                     Node for CLI check (default: node).
#   CURL                     curl binary (default: curl).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
fi
CURL="${CURL:-curl}"
NODE="${NODE:-node}"

RUN_LINKS=1
RUN_CLI=1
LOCAL_ONLY=0
EXTRA_FILES=()
VERBOSE="${CHECK_DOC_LINKS_VERBOSE:-0}"
WITH_SKILLS=0

usage() {
  cat <<'EOF'
Documentation checks: Markdown links + nemoclaw --help vs commands reference.

Usage: test/e2e/e2e-cloud-experimental/check-docs.sh [options] [extra.md ...]

Options:
  --only-links     Run only the Markdown link check.
  --only-cli       Run only the CLI help vs docs/reference/commands.md check.
  --local-only     Do not curl http(s) URLs (same as CHECK_DOC_LINKS_REMOTE=0).
  --with-skills    Also scan .agents/skills/**/*.md (link check).
  --verbose        Log each URL while curling (link check).
  -h, --help       Show this help.

Environment: CHECK_DOC_LINKS_REMOTE, CHECK_DOC_LINKS_VERBOSE, NODE, CURL.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only-links)
      RUN_CLI=0
      shift
      ;;
    --only-cli)
      RUN_LINKS=0
      shift
      ;;
    --local-only)
      LOCAL_ONLY=1
      shift
      ;;
    --with-skills)
      WITH_SKILLS=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_FILES+=("$@")
      break
      ;;
    -*)
      echo "check-docs: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      EXTRA_FILES+=("$1")
      shift
      ;;
  esac
done

if [[ "$RUN_LINKS" -eq 0 && "$RUN_CLI" -eq 0 ]]; then
  echo "check-docs: use at least one of default (both), --only-links, or --only-cli" >&2
  exit 2
fi

if [[ "$LOCAL_ONLY" -eq 1 ]]; then
  CHECK_DOC_LINKS_REMOTE=0
fi
CHECK_DOC_LINKS_REMOTE="${CHECK_DOC_LINKS_REMOTE:-1}"

log() {
  printf '%s\n' "check-docs: $*"
}

# --- CLI: --help vs commands.md -------------------------------------------------

run_cli_check() {
  local CLI_JS="$REPO_ROOT/bin/nemoclaw.js"
  local COMMANDS_MD="$REPO_ROOT/docs/reference/commands.md"

  if [[ ! -f "$CLI_JS" ]]; then
    echo "check-docs: [cli] missing $CLI_JS" >&2
    return 1
  fi
  if [[ ! -f "$COMMANDS_MD" ]]; then
    echo "check-docs: [cli] missing $COMMANDS_MD" >&2
    return 1
  fi
  if ! command -v "$NODE" >/dev/null 2>&1; then
    echo "check-docs: [cli] '$NODE' not found" >&2
    return 1
  fi

  local _tmp
  _tmp="$(mktemp -d)"

  log "[cli] comparing: NO_COLOR=1 $NODE bin/nemoclaw.js --help"
  # shellcheck disable=SC2016
  # log text: backticks are documentation markers, not command substitution
  log '[cli]        vs: docs/reference/commands.md (### `nemoclaw …` headings only)'
  log "[cli] excluded: openshell, /nemoclaw slash, deprecated nemoclaw setup (not in --help)"

  log "[cli] phase 1/2: extract normalized usage lines from --help"
  NO_COLOR=1 "$NODE" "$CLI_JS" --help 2>&1 | perl -CS -ne '
    s/\e\[[0-9;]*m//g;
    next unless /^\s*nemoclaw\s+/;
    if (/^\s*nemoclaw\s+(.+)/) {
      my $c = $1;
      $c =~ s/\s{2,}.*$//;
      $c =~ s/\s+$//;
      $c =~ s/\s*\[[^\]]*\]\s*$//;
      $c =~ s/\s*--output\s+FILE\s*$//;
      while ($c =~ s/\s+<[^>]+>\s*$//) {}
      my $k = "nemoclaw $c";
      $k =~ s/^nemoclaw debug.*/nemoclaw debug/;
      print "$k\n";
    }
  ' | LC_ALL=C sort -u >"$_tmp/help.txt"

  local _n_help
  _n_help="$(wc -l <"$_tmp/help.txt" | tr -d " ")"
  log "[cli] phase 1: extracted ${_n_help} unique command line(s) from --help"

  # shellcheck disable=SC2016
  # log text: backticks are documentation markers, not command substitution
  log '[cli] phase 2/2: extract ### `nemoclaw …` headings from commands reference'
  # Allow optional MyST suffix on the same line, e.g. ### `nemoclaw onboard` {#anchor}
  grep -E '^### `nemoclaw ' "$COMMANDS_MD" | perl -CS -ne '
    if (/^### `([^`]+)`\s*(?:\{[^}]+\})?\s*$/) { print "$1\n"; }
  ' | LC_ALL=C sort -u >"$_tmp/doc.txt"

  local _n_doc
  _n_doc="$(wc -l <"$_tmp/doc.txt" | tr -d " ")"
  log "[cli] phase 2: extracted ${_n_doc} heading(s) from ${COMMANDS_MD#"$REPO_ROOT"/}"

  if cmp -s "$_tmp/help.txt" "$_tmp/doc.txt"; then
    log "[cli] parity OK (${_n_help} nemoclaw command(s))"
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      log "[cli]   $line"
    done <"$_tmp/help.txt"
    log "[cli] done."
    rm -rf "$_tmp"
    return 0
  fi

  echo "check-docs: [cli] mismatch between --help and $COMMANDS_MD" >&2
  echo "" >&2
  echo "Only in --help (add ### to commands.md or fix help):" >&2
  comm -23 "$_tmp/help.txt" "$_tmp/doc.txt" | sed 's/^/  /' >&2 || true
  echo "" >&2
  echo "Only in commands.md (add to help() in bin/nemoclaw.js or fix heading):" >&2
  comm -13 "$_tmp/help.txt" "$_tmp/doc.txt" | sed 's/^/  /' >&2 || true
  rm -rf "$_tmp"
  return 1
}

# --- Markdown links -------------------------------------------------------------

collect_default_docs() {
  local f
  for f in \
    "$REPO_ROOT/README.md" \
    "$REPO_ROOT/CONTRIBUTING.md" \
    "$REPO_ROOT/docs/CONTRIBUTING.md" \
    "$REPO_ROOT/SECURITY.md" \
    "$REPO_ROOT/spark-install.md" \
    "$REPO_ROOT/CODE_OF_CONDUCT.md" \
    "$REPO_ROOT/.github/PULL_REQUEST_TEMPLATE.md"; do
    [[ -f "$f" ]] && printf '%s\n' "$f"
  done
  if [[ -d "$REPO_ROOT/docs" ]]; then
    find "$REPO_ROOT/docs" -type f -name '*.md' | LC_ALL=C sort
  fi
  if [[ "$WITH_SKILLS" -eq 1 && -d "$REPO_ROOT/.agents/skills" ]]; then
    find "$REPO_ROOT/.agents/skills" -type f -name '*.md' | LC_ALL=C sort
  fi
}

extract_targets() {
  perl -CS -ne '
    if (/^\s*```/) { $in = !$in; next; }
    next if $in;
    while (/\!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'"'"'][^)"'"'"']*["'"'"'])?\)/g) { print "$1\n"; }
    while (/<(https?:[^>\s]+)>/g) { print "$1\n"; }
  ' -- "$1"
}

check_local_ref() {
  local md_path="$1" target="$2"
  local stripped

  stripped="${target%%\#*}"
  stripped="${stripped%%\?*}"

  [[ -z "$stripped" ]] && return 0
  [[ "$stripped" == mailto:* ]] && return 0
  [[ "$stripped" == tel:* ]] && return 0
  [[ "$stripped" == javascript:* ]] && return 0

  if [[ "$stripped" == http://* || "$stripped" == https://* ]]; then
    return 2
  fi
  if [[ "$stripped" == *://* ]]; then
    return 0
  fi

  if (cd "$(dirname "$md_path")" && [[ -e "$stripped" ]]); then
    return 0
  fi
  echo "check-docs: [links] broken local link in $md_path -> $target" >&2
  return 1
}

check_remote_url() {
  local url="$1"
  if ! command -v "$CURL" >/dev/null 2>&1; then
    echo "check-docs: [links] curl not found; cannot verify $url" >&2
    return 1
  fi
  if ! "$CURL" -fsS -L -o /dev/null \
    --connect-timeout 12 --max-time 35 \
    -A 'NemoClaw-doc-link-check/1.0 (+https://github.com/NVIDIA/NemoClaw)' \
    "$url" 2>/dev/null; then
    echo "check-docs: [links] unreachable URL: $url" >&2
    return 1
  fi
  return 0
}

run_links_check() {
  local -a DOC_FILES
  if [[ ${#EXTRA_FILES[@]} -gt 0 ]]; then
    DOC_FILES=("${EXTRA_FILES[@]}")
  else
    DOC_FILES=()
    while IFS= read -r _docf || [[ -n "${_docf:-}" ]]; do
      [[ -z "${_docf:-}" ]] && continue
      DOC_FILES+=("$_docf")
    done < <(collect_default_docs | LC_ALL=C sort -u)
  fi

  if [[ ${#DOC_FILES[@]} -eq 0 ]]; then
    echo "check-docs: [links] no documentation files to scan under $REPO_ROOT" >&2
    return 1
  fi

  log "[links] repository root: $REPO_ROOT"
  if [[ "$WITH_SKILLS" -eq 1 ]]; then
    log "[links] scope: default doc set + .agents/skills/**/*.md"
  else
    log "[links] scope: README, CONTRIBUTING, SECURITY, spark-install, CODE_OF_CONDUCT, .github PR template, docs/**/*.md"
  fi
  if [[ "$CHECK_DOC_LINKS_REMOTE" != 0 ]]; then
    log "[links] remote: curl unique http(s) targets (disable: CHECK_DOC_LINKS_REMOTE=0 or --local-only)"
  else
    log "[links] remote: skipped (local paths only)"
  fi
  log "[links] Markdown file(s) (${#DOC_FILES[@]}):"
  local md
  for md in "${DOC_FILES[@]}"; do
    case "$md" in
      "$REPO_ROOT"/*) log "[links]   ${md#"$REPO_ROOT"/}" ;;
      *) log "[links]   $md" ;;
    esac
  done

  local failures=0
  declare -a REMOTE_URLS=()

  log "[links] phase 1/2: local file targets for [](url) / ![]() / <https://> (code fences skipped)"
  for md in "${DOC_FILES[@]}"; do
    if [[ ! -f "$md" ]]; then
      echo "check-docs: [links] missing file: $md" >&2
      failures=1
      continue
    fi
    local target rc
    while IFS= read -r target || [[ -n "$target" ]]; do
      [[ -z "$target" ]] && continue
      set +e
      check_local_ref "$md" "$target"
      rc=$?
      set -e
      if [[ "$rc" -eq 0 ]]; then
        continue
      elif [[ "$rc" -eq 2 ]]; then
        REMOTE_URLS+=("$target")
      else
        failures=1
      fi
    done < <(extract_targets "$md")
  done

  if [[ "$failures" -ne 0 ]]; then
    log "[links] phase 1 failed"
    return 1
  fi
  log "[links] phase 1 OK (local paths resolve from each .md directory)"

  local _n_raw _deduped _unique _i _u url
  _n_raw="${#REMOTE_URLS[@]}"
  _deduped=""
  if [[ ${#REMOTE_URLS[@]} -gt 0 ]]; then
    _deduped="$(printf '%s\n' "${REMOTE_URLS[@]}" | LC_ALL=C sort -u)"
  fi
  _unique="$(printf '%s\n' "${REMOTE_URLS[@]}" | LC_ALL=C sort -u | grep -c . || true)"
  log "[links] http(s): ${_n_raw} reference(s) → ${_unique} unique URL(s)"
  if [[ -n "$_deduped" ]]; then
    log "[links] unique http(s) URL(s) (alphabetically):"
    while IFS= read -r _u || [[ -n "${_u:-}" ]]; do
      [[ -z "${_u:-}" ]] && continue
      log "[links]   ${_u}"
    done <<<"$_deduped"
  fi

  if [[ "$CHECK_DOC_LINKS_REMOTE" != 0 ]]; then
    if [[ -n "$_deduped" ]]; then
      log "[links] phase 2/2: curl ${_unique} URL(s) (GET, -L, fail 4xx/5xx)"
      _i=0
      while IFS= read -r url || [[ -n "$url" ]]; do
        [[ -z "$url" ]] && continue
        _i=$((_i + 1))
        if [[ "$VERBOSE" -eq 1 ]]; then
          log "[links]   [${_i}/${_unique}] ${url}"
        fi
        if ! check_remote_url "$url"; then
          failures=1
        fi
      done <<<"$_deduped"
    else
      log "[links] phase 2/2: no http(s) links"
    fi
  else
    if [[ -n "$_deduped" ]]; then
      log "[links] phase 2/2: skipped ${_unique} URL(s) (local-only)"
    else
      log "[links] phase 2/2: skipped (no http(s) links)"
    fi
  fi

  if [[ "$failures" -ne 0 ]]; then
    log "[links] phase 2 failed"
    return 1
  fi
  if [[ "$CHECK_DOC_LINKS_REMOTE" != 0 ]] && [[ ${_unique:-0} -gt 0 ]]; then
    log "[links] phase 2 OK (${_unique} URL(s))"
  fi
  log "[links] summary: ${#DOC_FILES[@]} file(s), local OK$(
    [[ "$CHECK_DOC_LINKS_REMOTE" != 0 ]] && [[ ${_unique:-0} -gt 0 ]] && printf ', %s remote OK' "${_unique}"
  )$(
    [[ "$CHECK_DOC_LINKS_REMOTE" == 0 ]] && [[ ${_unique:-0} -gt 0 ]] && printf ' (%s remote not checked)' "${_unique}"
  )"
  log "[links] done."
  return 0
}

# --- main ---------------------------------------------------------------------

if [[ "$RUN_LINKS" -eq 1 && "$RUN_CLI" -eq 1 ]]; then
  log "running both: [cli] then [links] (--only-links / --only-cli for one)"
elif [[ "$RUN_LINKS" -eq 1 ]]; then
  log "running: [links] only"
else
  log "running: [cli] only"
fi

if [[ "$RUN_CLI" -eq 1 ]]; then
  if ! run_cli_check; then
    exit 1
  fi
fi

if [[ "$RUN_LINKS" -eq 1 ]]; then
  if ! run_links_check; then
    exit 1
  fi
fi

log "all requested checks passed."
exit 0
