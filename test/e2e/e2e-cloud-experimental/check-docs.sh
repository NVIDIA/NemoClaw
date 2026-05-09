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
#   CHECK_DOC_LINKS_IGNORE_EXTRA  Comma-separated extra http(s) URLs to skip curling (exact match, #fragment ignored).
#   CHECK_DOC_LINKS_IGNORE_URL_REGEX  If set, skip curl when the whole URL matches this ERE (bash [[ =~ ]]).
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
RUN_INSTALL=1
LOCAL_ONLY=0
EXTRA_FILES=()
VERBOSE="${CHECK_DOC_LINKS_VERBOSE:-0}"
WITH_SKILLS=0

usage() {
  cat <<'EOF'
Documentation checks: Markdown links + nemoclaw --help vs commands reference
+ install.sh --help vs canonical provider list.

Usage: test/e2e/e2e-cloud-experimental/check-docs.sh [options] [extra.md ...]

Options:
  --only-links     Run only the Markdown link check.
  --only-cli       Run only the CLI help vs docs/reference/commands.md check
                   (includes both command-level and flag-level parity).
  --only-install   Run only the install.sh --help vs canonical provider check.
  --local-only     Do not curl http(s) URLs (same as CHECK_DOC_LINKS_REMOTE=0).
  --with-skills    Also scan .agents/skills/**/*.md (link check).
  --verbose        Log each URL while curling (link check).
  -h, --help       Show this help.

Environment: CHECK_DOC_LINKS_REMOTE, CHECK_DOC_LINKS_VERBOSE, CHECK_DOC_LINKS_IGNORE_EXTRA,
  CHECK_DOC_LINKS_IGNORE_URL_REGEX, NODE, CURL.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only-links)
      RUN_CLI=0
      RUN_INSTALL=0
      shift
      ;;
    --only-cli)
      RUN_LINKS=0
      RUN_INSTALL=0
      shift
      ;;
    --only-install)
      RUN_LINKS=0
      RUN_CLI=0
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

if [[ "$RUN_LINKS" -eq 0 && "$RUN_CLI" -eq 0 && "$RUN_INSTALL" -eq 0 ]]; then
  echo "check-docs: use at least one of default (all), --only-links, --only-cli, or --only-install" >&2
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
  local _cli_home="$_tmp/home"
  mkdir -p "$_cli_home/.nemoclaw"
  cat >"$_cli_home/.nemoclaw/sandboxes.json" <<'JSON'
{"defaultSandbox":"placeholder-sandbox","sandboxes":{"placeholder-sandbox":{"name":"placeholder-sandbox"}}}
JSON

  log "[cli] comparing: $NODE bin/nemoclaw.js --dump-commands"
  # shellcheck disable=SC2016
  # log text: backticks are documentation markers, not command substitution
  log '[cli]        vs: docs/reference/commands.md (### `nemoclaw …` headings only)'

  log "[cli] phase 1/2: dump canonical command list from registry"
  if ! HOME="$_cli_home" "$NODE" "$CLI_JS" --dump-commands >"$_tmp/help.txt" 2>"$_tmp/help.err"; then
    cat "$_tmp/help.err" >&2
    rm -rf "$_tmp"
    return 1
  fi
  LC_ALL=C sort -u -o "$_tmp/help.txt" "$_tmp/help.txt"

  local _n_help
  _n_help="$(wc -l <"$_tmp/help.txt" | tr -d " ")"
  log "[cli] phase 1: extracted ${_n_help} unique command line(s) from --dump-commands"

  # shellcheck disable=SC2016
  # log text: backticks are documentation markers, not command substitution
  log '[cli] phase 2/2: extract ### `nemoclaw …` headings from commands reference'
  # Allow optional MyST suffix on the same line, e.g. ### `nemoclaw onboard` {#anchor}
  # Strip argument placeholders (<arg>, [optional]) to match canonical usage signatures.
  grep -E '^### `nemoclaw ' "$COMMANDS_MD" | LC_ALL=C perl -CS -ne '
    if (/^### `([^`]+)`\s*(?:\{[^}]+\})?\s*$/) {
      my $c = $1;
      while ($c =~ s/\s*\[[^\]]*\]\s*$//) {}
      while ($c =~ s/\s+<[^>]+>\s*$//) {}
      $c =~ s/\s+$//;
      print "$c\n";
    }
  ' | LC_ALL=C sort -u >"$_tmp/doc.txt"

  local _n_doc
  _n_doc="$(wc -l <"$_tmp/doc.txt" | tr -d " ")"
  log "[cli] phase 2: extracted ${_n_doc} heading(s) from ${COMMANDS_MD#"$REPO_ROOT"/}"

  if ! cmp -s "$_tmp/help.txt" "$_tmp/doc.txt"; then
    echo "check-docs: [cli] mismatch between --help and $COMMANDS_MD" >&2
    echo "" >&2
    echo "Only in --help (add ### to commands.md or fix help):" >&2
    comm -23 "$_tmp/help.txt" "$_tmp/doc.txt" | sed 's/^/  /' >&2 || true
    echo "" >&2
    echo "Only in commands.md (add to help() in bin/nemoclaw.js or fix heading):" >&2
    comm -13 "$_tmp/help.txt" "$_tmp/doc.txt" | sed 's/^/  /' >&2 || true
    rm -rf "$_tmp"
    return 1
  fi

  log "[cli] command-level parity OK (${_n_help} nemoclaw command(s))"

  # ── Phase 3/3: flag-level parity (NemoClaw#3224) ──────────────────────────
  # For each command, run its `--help`, extract every long-form flag mentioned,
  # and confirm each appears within that command's own section in
  # commands.md (between its `### \`nemoclaw <cmd>\`` heading and the next
  # ### heading). Two help formats coexist: oclif global commands use a
  # USAGE/FLAGS layout; `nemoclaw <name> ...` commands use a custom
  # Options: section. Greping the full help output handles both formats.
  # Section-scoped grep avoids false negatives where a flag like `--yes`
  # appears in many sections but is missing from the one being audited.
  # Word-boundary regex avoids false positives where `--yes` is contained
  # in `--yes-i-accept-third-party-software`. Skips global -h/--help/--version.
  #
  # The check runs with an isolated HOME that contains a fake
  # `placeholder-sandbox` registry entry. That keeps CI deterministic and lets
  # sandbox-scoped commands print `--help` without touching the user's real
  # ~/.nemoclaw state.
  log "[cli] phase 3/3: flag-level parity"

  # Awk extractor: print lines belonging to the section whose heading
  # canonicalizes to <cmd> after the same trailing-placeholder strip phase 2
  # applies (`### \`nemoclaw foo <ARG>\`` → `nemoclaw foo`). Stops at the
  # next ### heading. MyST anchors after the closing backtick are tolerated.
  extract_md_section() {
    local cmd="$1"
    local md="$2"
    LC_ALL=C awk -v target="$cmd" '
      # End the section when a new top-level heading appears (h1, h2, or
      # h3). h4+ are kept since they are sub-sections of the same command.
      # Explicit alternation since traditional awk treats `{n,m}` literally.
      in_sec && /^(# |## |### )/ { exit }
      /^### `/ {
        line = $0
        sub(/^### `/, "", line)
        bt = index(line, "`")
        if (bt > 0) {
          cand = substr(line, 1, bt - 1)
          while (sub(/[[:space:]]*\[[^]]*\][[:space:]]*$/, "", cand)) {}
          while (sub(/[[:space:]]+<[^>]+>[[:space:]]*$/, "", cand)) {}
          sub(/[[:space:]]+$/, "", cand)
          if (cand == target) {
            in_sec = 1
            next
          }
        }
      }
      in_sec { print }
    ' "$md"
  }

  extract_help_flags() {
    printf '%s\n' "$1" | LC_ALL=C perl -CS -ne '
      sub emit_flags {
        my ($s) = @_;
        while ($s =~ /--(?:\[no-\])?([a-z][a-z0-9-]+)/g) {
          my $flag = $1;
          my $matched = $&;
          print "--$flag\n";
          print "--no-$flag\n" if $matched =~ /^\Q--[no-]\E/;
        }
      }

      if (/^\s*Usage:\s*(.*)$/i) {
        $mode = "usage";
        emit_flags($1);
        next;
      }
      if (/^\s*USAGE\s*$/) {
        $mode = "usage";
        next;
      }
      if (/^\s*(FLAGS|GLOBAL FLAGS|Options):?\s*$/i) {
        $mode = "flags";
        next;
      }
      if (/^\s*(ARGUMENTS|DESCRIPTION|EXAMPLES)\s*$/i || /^\s*$/) {
        $mode = "";
        next;
      }
      emit_flags($_) if $mode;
    ' | LC_ALL=C sort -u
  }

  local _flag_drift=0
  while IFS= read -r cmd_line || [[ -n "$cmd_line" ]]; do
    [[ -z "$cmd_line" ]] && continue
    # Skip "command-line variant" entries like `nemoclaw onboard --from`
    # — those describe a flagged invocation of a parent command (here
    # `nemoclaw onboard`) that is iterated separately. Re-invoking them
    # with `--help` would just trigger flag-value parsing errors.
    case "$cmd_line" in *" --"*) continue ;; esac
    # `--dump-commands` lines start with `nemoclaw `; strip that since we
    # re-invoke via `node bin/nemoclaw.js`. Then replace <name> with a
    # sandbox name that passes name validation (lowercase, starts with
    # letter, only letters/digits/hyphens — underscores are rejected).
    local invoke
    invoke="${cmd_line#nemoclaw }"
    invoke="${invoke//<name>/placeholder-sandbox}"
    # Read into an array so each space-separated token is a distinct argv
    # element to node — avoids SC2086 and any quoting surprises.
    local -a _invoke_args
    read -ra _invoke_args <<<"$invoke"
    # Redirect stdin to /dev/null. The outer `while read` is consuming
    # `$_tmp/help.txt` via `done <` redirection; any inner command that
    # touches stdin (some node startup paths do) would eat subsequent
    # lines, silently truncating the iteration. Negative-tested by
    # mutating commands.md and confirming drift is now reported.
    #
    # Capture exit code separately so a real failure (broken command path,
    # crashed loader, etc.) propagates instead of being swallowed by
    # `|| true`.
    local _help_text _help_err _help_rc=0
    _help_err="$(mktemp)"
    _help_text="$(HOME="$_cli_home" "$NODE" "$CLI_JS" "${_invoke_args[@]}" --help </dev/null 2>"$_help_err")" || _help_rc=$?
    if [[ "$_help_rc" -ne 0 ]]; then
      cat "$_help_err" >&2
      rm -f "$_help_err"
      rm -rf "$_tmp"
      return 1
    fi
    rm -f "$_help_err"
    [[ -z "$_help_text" ]] && continue

    local _flags
    _flags="$(extract_help_flags "$_help_text")"
    [[ -z "$_flags" ]] && continue

    local _section
    _section="$(extract_md_section "$cmd_line" "$COMMANDS_MD")"
    if [[ -z "$_section" ]]; then
      # Phase 2 already enforces the heading exists; if the section is
      # somehow empty here, fall back to the full doc rather than skipping.
      _section="$(cat "$COMMANDS_MD")"
    fi

    while IFS= read -r flag; do
      [[ -z "$flag" ]] && continue
      case "$flag" in --help | --version) continue ;; esac
      # Word-boundary regex: treat letters/digits/_/- as continuation chars
      # so `--yes` does not match inside `--yes-i-accept-third-party-software`.
      local _pat="(^|[^a-zA-Z0-9_-])${flag}([^a-zA-Z0-9_-]|$)"
      if ! grep -qE -- "$_pat" <<<"$_section"; then
        echo "check-docs: [cli] flag $flag (from \`$cmd_line --help\`) not in '$cmd_line' section of $COMMANDS_MD" >&2
        _flag_drift=1
      fi
    done <<<"$_flags"

    # Reverse direction: extract long flags mentioned in the doc section
    # and confirm each appears in the actual --help. Catches stale docs
    # (flag removed from CLI but still listed in commands.md).
    #
    # Scoping rule: inside fenced code blocks (where USAGE lines live like
    # `[--non-interactive]`), any `--foo` counts. Outside fences, only
    # backtick-bounded `\`--foo\`` mentions count, so prose references to
    # other tools (e.g. `\`openshell gateway start --recreate\``) don't get
    # mistaken for nemoclaw flag documentation.
    local _doc_flags
    _doc_flags="$(
      printf '%s\n' "$_section" \
        | LC_ALL=C perl -CS -ne '
            if (/^```/) { $in_fence = !$in_fence; next; }
            if ($in_fence) {
              while (/--([a-z][a-z0-9-]+)/g) { print "--$1\n"; }
            } else {
              while (/`--([a-z][a-z0-9-]+)/g) { print "--$1\n"; }
            }
          ' \
        | grep -vxE -- '--help|--version' \
        | LC_ALL=C sort -u || true
    )"
    while IFS= read -r flag; do
      [[ -z "$flag" ]] && continue
      if ! grep -qxF -- "$flag" <<<"$_flags"; then
        echo "check-docs: [cli] flag $flag documented under \`$cmd_line\` but absent from \`$cmd_line --help\`" >&2
        _flag_drift=1
      fi
    done <<<"$_doc_flags"
  done <"$_tmp/help.txt"

  if [[ "$_flag_drift" -ne 0 ]]; then
    rm -rf "$_tmp"
    return 1
  fi

  log "[cli] flag-level parity OK"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    log "[cli]   $line"
  done <"$_tmp/help.txt"
  log "[cli] done."
  rm -rf "$_tmp"
  return 0
}

# --- Install: install.sh --help vs canonical provider list (NemoClaw#3224) ----

run_install_check() {
  # Two installer entry points need to stay in sync with the canonical
  # provider list:
  #   1. install.sh (bootstrap_usage) — what users see via `curl | bash --help`
  #   2. scripts/install.sh — what the bootstrap sources locally; what users
  #      see when they run `bash install.sh --help` from a clone
  local BOOTSTRAP_SH="$REPO_ROOT/install.sh"
  local PAYLOAD_SH="$REPO_ROOT/scripts/install.sh"

  # The providers list has moved between layouts; tolerate both the legacy
  # flat path and the post-refactor layered path.
  local PROVIDERS_TS=""
  for _candidate in \
    "$REPO_ROOT/src/lib/onboard/providers.ts" \
    "$REPO_ROOT/src/lib/onboard-providers.ts"; do
    if [[ -f "$_candidate" ]]; then
      PROVIDERS_TS="$_candidate"
      break
    fi
  done

  if [[ ! -f "$BOOTSTRAP_SH" ]]; then
    echo "check-docs: [install] missing $BOOTSTRAP_SH" >&2
    return 1
  fi
  if [[ -z "$PROVIDERS_TS" ]]; then
    echo "check-docs: [install] could not locate onboard providers TS source" >&2
    return 1
  fi

  log "[install] comparing: NEMOCLAW_PROVIDER values in install.sh + scripts/install.sh"
  log "[install]        vs: ${PROVIDERS_TS#"$REPO_ROOT"/} canonical 'Valid values' list"

  # The canonical values live in a single error-message line that lists every
  # accepted NEMOCLAW_PROVIDER input. Extract the comma-separated payload.
  local _canonical
  _canonical="$(grep -oE 'Valid values: [^"]+' "$PROVIDERS_TS" | head -1 | sed 's/^Valid values: //')"
  if [[ -z "$_canonical" ]]; then
    echo "check-docs: [install] could not locate canonical provider list in $PROVIDERS_TS" >&2
    return 1
  fi

  # Extract the NEMOCLAW_PROVIDER usage block from each script (the printf
  # lines starting at NEMOCLAW_PROVIDER through the next NEMOCLAW_ entry or
  # blank-line printf), then verify each canonical value appears within that
  # block. Grepping the whole script would match unrelated mentions of
  # `gemini` / `ollama` in helper text, prompts, etc.
  #
  # Skip the install-helper / wizard-only keys (install-vllm, install-ollama,
  # install-windows-ollama, start-windows-ollama). They are option keys the
  # interactive wizard exposes, not values a user is expected to set
  # NEMOCLAW_PROVIDER to from the installer entrypoint.
  extract_provider_block() {
    # Order matters: check the boundary BEFORE printing so the next
    # NEMOCLAW_* printf line (e.g. NEMOCLAW_POLICY_MODE) does not bleed
    # into the block. `custom` is both a canonical provider value and a
    # POLICY_MODE token, so a leaked POLICY line would falsely make it
    # appear that `custom` is documented even after removal.
    awk '
      /printf .*NEMOCLAW_PROVIDER/ { in_block = 1; print; next }
      in_block && /printf .*NEMOCLAW_/ && !/NEMOCLAW_PROVIDER/ {
        in_block = 0
      }
      in_block { print }
    ' "$1"
  }

  local _bootstrap_block _payload_block _drift=0
  _bootstrap_block="$(extract_provider_block "$BOOTSTRAP_SH")"
  if [[ -z "$_bootstrap_block" ]]; then
    echo "check-docs: [install] no NEMOCLAW_PROVIDER block found in $BOOTSTRAP_SH" >&2
    return 1
  fi
  if [[ -f "$PAYLOAD_SH" ]]; then
    _payload_block="$(extract_provider_block "$PAYLOAD_SH")"
  fi

  # Tokenize each block into the discrete provider identifiers it mentions
  # so we can exact-match (not substring-match) against the canonical list.
  # Substring matching would let `anthropic` falsely pass when only
  # `anthropicCompatible` appears.
  # The pattern allows camelCase since `anthropicCompatible` is canonical.
  # `\n` literals in printf strings are stripped first so tokens at line
  # ends (e.g. `routed\n"`) reduce to the bare identifier.
  tokenize_provider_block() {
    # Drop `(aliases: cloud -> build, ...)` lines (alias keys aren't
    # canonical providers and would falsely fail the bidirectional check)
    # and the shell tokens `printf` / `NEMOCLAW_PROVIDER` that appear
    # because the block opens with a `printf "    NEMOCLAW_PROVIDER ..."`
    # line. Both filters exist solely to clean up tokenization artifacts;
    # they don't relax the actual provider-name check.
    printf '%s\n' "$1" \
      | grep -v '(aliases:' \
      | sed 's/\\n//g' \
      | tr '"`,()|' '\n' \
      | awk '{ for (i = 1; i <= NF; i++) print $i }' \
      | grep -E '^[a-zA-Z][a-zA-Z0-9-]*$' \
      | grep -vxE 'printf|NEMOCLAW_PROVIDER' \
      | LC_ALL=C sort -u
  }

  local _bootstrap_values _payload_values=""
  _bootstrap_values="$(tokenize_provider_block "$_bootstrap_block")"
  if [[ -n "${_payload_block:-}" ]]; then
    _payload_values="$(tokenize_provider_block "$_payload_block")"
  fi

  IFS=',' read -ra _values <<<"$_canonical"
  for _raw in "${_values[@]}"; do
    local v
    v="$(echo "$_raw" | tr -d '[:space:]')"
    [[ -z "$v" ]] && continue
    case "$v" in install-* | start-windows-ollama) continue ;; esac
    if ! grep -qxF -- "$v" <<<"$_bootstrap_values"; then
      echo "check-docs: [install] provider \"$v\" canonical but absent from $BOOTSTRAP_SH bootstrap_usage" >&2
      _drift=1
    fi
    if [[ -n "$_payload_values" ]] && ! grep -qxF -- "$v" <<<"$_payload_values"; then
      echo "check-docs: [install] provider \"$v\" canonical but absent from $PAYLOAD_SH usage()" >&2
      _drift=1
    fi
  done

  # Reverse direction: tokens appearing in either install help block but
  # not on the canonical list mean the script is advertising a provider
  # that the CLI no longer accepts. Build the canonical set with the same
  # exemptions used above.
  local _canonical_values
  _canonical_values="$(
    printf '%s\n' "$_canonical" \
      | tr ',' '\n' \
      | sed 's/[[:space:]]//g' \
      | grep -vxE 'install-.*|start-windows-ollama' \
      | grep -E '^[a-zA-Z][a-zA-Z0-9-]*$' \
      | LC_ALL=C sort -u
  )"
  while IFS= read -r v; do
    [[ -z "$v" ]] && continue
    if ! grep -qxF -- "$v" <<<"$_canonical_values"; then
      echo "check-docs: [install] provider \"$v\" appears in $BOOTSTRAP_SH bootstrap_usage but is not canonical" >&2
      _drift=1
    fi
  done <<<"$_bootstrap_values"
  if [[ -n "$_payload_values" ]]; then
    while IFS= read -r v; do
      [[ -z "$v" ]] && continue
      if ! grep -qxF -- "$v" <<<"$_canonical_values"; then
        echo "check-docs: [install] provider \"$v\" appears in $PAYLOAD_SH usage() but is not canonical" >&2
        _drift=1
      fi
    done <<<"$_payload_values"
  fi

  if [[ "$_drift" -ne 0 ]]; then
    return 1
  fi

  log "[install] parity OK"
  log "[install] done."
  return 0
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
  LC_ALL=C perl -CS -ne '
    if ($in_fence) {
      if (/^\s*(`{3,}|~{3,})(.*)$/) {
        my $fence = $1;
        my $rest = $2;
        my $char = substr($fence, 0, 1);
        my $length = length($fence);
        if ($char eq $fch && $length >= $flen && $rest =~ /^\s*$/) {
          ($in_fence, $fch, $flen) = (0, "", 0);
        }
      }
      next;
    }

    my $line = $.;
    my $text = $_;
    my $visible = "";

    while (length $text) {
      if ($in_comment) {
        if ($text =~ s/^(.*?)-->//s) {
          $in_comment = 0;
          next;
        }
        $text = "";
        next;
      }

      if ($text =~ s/^(.*?)<!--//s) {
        $visible .= $1;
        $in_comment = 1;
        next;
      }

      if ($text =~ /-->/) {
        die "malformed HTML comment\n";
      }

      $visible .= $text;
      last;
    }

    if ($visible =~ /^\s*(`{3,}|~{3,})(.*)$/) {
      my $fence = $1;
      my $char = substr($fence, 0, 1);
      my $length = length($fence);
      ($in_fence, $fch, $flen) = (1, $char, $length);
      next;
    }

    while ($visible =~ /\!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'"'"'][^)"'"'"']*["'"'"'])?\)/g) { print $line . "\t" . $1 . "\n"; }
    while ($visible =~ /<(https?:[^>\s]+)>/g) { print $line . "\t" . $1 . "\n"; }
    END {
      die "malformed HTML comment\n" if $in_comment;
    }
  ' -- "$1"
}

check_local_ref() {
  local md_path="$1" line_no="$2" target="$3"
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
  echo "check-docs: [links] broken local link in $md_path:$line_no -> $target" >&2
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

# Normalized form: strip #fragment and trailing slash for ignore-list comparison.
normalize_url_for_ignore_match() {
  local u="$1"
  u="${u%%\#*}"
  u="${u%/}"
  printf '%s' "$u"
}

# Built-in skip list: pages that often fail in CI (bot wall, redirects, or flaky) but are non-critical for doc correctness.
check_docs_default_ignored_urls() {
  printf '%s\n' \
    'https://github.com/NVIDIA/NemoClaw/commits/main' \
    'https://github.com/NVIDIA/NemoClaw/pulls?q=is%3Apr+is%3Amerged' \
    'https://github.com/NVIDIA/NemoClaw/pulls?q=is:pr+is:merged' \
    'https://github.com/openclaw/openclaw/issues/49950'
}

url_should_skip_remote_probe() {
  local url="$1"
  local nu ign _re
  nu="$(normalize_url_for_ignore_match "$url")"

  while IFS= read -r ign || [[ -n "${ign:-}" ]]; do
    [[ -z "${ign:-}" ]] && continue
    [[ "$(normalize_url_for_ignore_match "$ign")" == "$nu" ]] && return 0
  done < <(check_docs_default_ignored_urls)

  if [[ -n "${CHECK_DOC_LINKS_IGNORE_EXTRA:-}" ]]; then
    local -a _extra_parts=()
    local IFS=','
    read -ra _extra_parts <<<"${CHECK_DOC_LINKS_IGNORE_EXTRA}"
    unset IFS
    for ign in "${_extra_parts[@]}"; do
      ign="${ign#"${ign%%[![:space:]]*}"}"
      ign="${ign%"${ign##*[![:space:]]}"}"
      [[ -z "$ign" ]] && continue
      [[ "$(normalize_url_for_ignore_match "$ign")" == "$nu" ]] && return 0
    done
  fi

  if [[ -n "${CHECK_DOC_LINKS_IGNORE_URL_REGEX:-}" ]]; then
    _re="${CHECK_DOC_LINKS_IGNORE_URL_REGEX}"
    [[ "$url" =~ $_re ]] && return 0
  fi

  return 1
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
    log "[links] remote: built-in skip list for flaky/GitHub pages (override: CHECK_DOC_LINKS_IGNORE_EXTRA, CHECK_DOC_LINKS_IGNORE_URL_REGEX)"
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
    local _targets_output _targets_err
    _targets_err="$(mktemp)"
    if ! _targets_output="$(extract_targets "$md" 2>"$_targets_err")"; then
      echo "check-docs: [links] malformed HTML comment in $md: $(tr '\n' ' ' <"$_targets_err" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')" >&2
      rm -f "$_targets_err"
      failures=1
      continue
    fi
    rm -f "$_targets_err"
    local line_no
    while IFS=$'\t' read -r line_no target || [[ -n "${target:-}" ]]; do
      [[ -z "$target" ]] && continue
      set +e
      check_local_ref "$md" "$line_no" "$target"
      rc=$?
      set -e
      if [[ "$rc" -eq 0 ]]; then
        continue
      elif [[ "$rc" -eq 2 ]]; then
        REMOTE_URLS+=("$target")
      else
        failures=1
      fi
    done <<<"$_targets_output"
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
      local _probe_list="" _skip_count=0 _probe_n=0
      while IFS= read -r url || [[ -n "${url:-}" ]]; do
        [[ -z "${url:-}" ]] && continue
        if url_should_skip_remote_probe "$url"; then
          log "[links]   skipped (ignore list): ${url}"
          _skip_count=$((_skip_count + 1))
        else
          _probe_list+="${url}"$'\n'
        fi
      done <<<"$_deduped"
      _probe_n="$(printf '%s\n' "$_probe_list" | grep -c . || true)"
      if [[ "$_skip_count" -gt 0 ]]; then
        log "[links] phase 2/2: curl ${_probe_n} URL(s), ${_skip_count} skipped (GET, -L, fail 4xx/5xx)"
      else
        log "[links] phase 2/2: curl ${_probe_n} URL(s) (GET, -L, fail 4xx/5xx)"
      fi
      _i=0
      while IFS= read -r url || [[ -n "${url:-}" ]]; do
        [[ -z "${url:-}" ]] && continue
        _i=$((_i + 1))
        if [[ "$VERBOSE" -eq 1 ]]; then
          log "[links]   [${_i}/${_probe_n}] ${url}"
        fi
        if ! check_remote_url "$url"; then
          failures=1
        fi
      done <<<"$_probe_list"
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
    log "[links] phase 2 OK (${_unique} unique http(s); probed those not in ignore list)"
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

_planned=()
[[ "$RUN_CLI" -eq 1 ]] && _planned+=("[cli]")
[[ "$RUN_INSTALL" -eq 1 ]] && _planned+=("[install]")
[[ "$RUN_LINKS" -eq 1 ]] && _planned+=("[links]")
log "running: ${_planned[*]}"
unset _planned

if [[ "$RUN_CLI" -eq 1 ]]; then
  if ! run_cli_check; then
    exit 1
  fi
fi

if [[ "$RUN_INSTALL" -eq 1 ]]; then
  if ! run_install_check; then
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
