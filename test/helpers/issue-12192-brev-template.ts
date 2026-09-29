// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

// This prospective payload describes the dependent #12239 tree, which adds
// scripts/lib/npm-diagnostics.sh before executing the embedded standalone copy.
const ISSUE_12192_NPM_DIAGNOSTICS = [
  "# Keep aligned with scripts/lib/npm-diagnostics.sh.",
  "# BEGIN npm diagnostics helper",
  "sanitize_npm_diagnostics() {",
  "  LC_ALL=C sed -E \\",
  "    -e $'s/\\033\\\\][^\\007\\033]*(\\007|\\033\\\\\\\\)//g' \\",
  "    -e $'s/\\033\\\\[[0-?]*[ -\\\\/]*[@-~]//g' \\",
  "    | LC_ALL=C tr '\\015' '\\012' \\",
  "    | LC_ALL=C tr -cd '\\11\\12\\40-\\176' \\",
  "    | awk '",
  "    BEGIN { private_key = 0 }",
  "    {",
  "      line = $0",
  "      lower = tolower(line)",
  "      if (line ~ /-----BEGIN ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) {",
  '        print "<REDACTED>"',
  "        private_key = 1",
  "        next",
  "      }",
  "      if (private_key) {",
  "        if (line ~ /-----END ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) private_key = 0",
  "        next",
  "      }",
  "      if (lower ~ /(authorization|proxy-authorization|cookie|set-cookie)[ \\t]*[:=]/ ||",
  "          lower ~ /(bearer|basic)[ \\t]+[^ \\t]/ ||",
  "          lower ~ /(^|[^a-z0-9])[a-z0-9_.-]*(auth|credential|key|pass|passwd|password|secret|token)[a-z0-9_.-]*[ \\t]*[:=]/) {",
  '        print "<REDACTED CREDENTIAL LINE>"',
  "        next",
  "      }",
  "      print line",
  "    }",
  "  ' \\",
  "    | sed -E \\",
  "      -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]'\"'\"'\"]+#<REDACTED_URL>#g' \\",
  "      -e 's#(github_pat_|ghp_|glpat-|gsk_|hf_|nvcf-|nvapi-|pypi-|sk-(ant-|proj-)?|tvly-|xapp-|xox[bpas]-)[A-Za-z0-9_-]{8,}#<REDACTED>#g' \\",
  "      -e 's#eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]{10,}#<REDACTED>#g' \\",
  "      -e 's#[A-Za-z0-9_+/=-]{32,}#<REDACTED>#g'",
  "}",
  "",
  "bounded_npm_diagnostic_excerpt() {",
  '  local limit="${1:-3900}"',
  '  LC_ALL=C awk -v limit="$limit" \'',
  "    {",
  "      tail = tail $0 ORS",
  "      if (length(tail) > limit) tail = substr(tail, length(tail) - limit + 1)",
  "      if ($0 ~ /^npm (error|ERR!|verbose stack)( |$)/ && length(errors) < 2000)",
  "        errors = substr(errors $0 ORS, 1, 2000)",
  "    }",
  "    END {",
  "      remaining = limit - length(errors)",
  "      if (length(tail) > remaining) tail = substr(tail, length(tail) - remaining + 1)",
  '      printf "%s%s", errors, tail',
  "    }",
  "  '",
  "}",
  "# END npm diagnostics helper",
  "",
  "run_npm_install_with_diagnostics() (",
  '  readonly stage="$1"',
  '  readonly working_directory="$2"',
  "  readonly MAX_EXCERPT_BYTES=3900",
  '  caller_umask="$(umask)"',
  "  readonly caller_umask",
  "  umask 077",
  '  diagnostic_directory="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-npm-install.XXXXXX")"',
  "  readonly diagnostic_directory",
  '  readonly command_log="$diagnostic_directory/npm-install.redacted.log"',
  '  trap \'if ! rm -rf -- "$diagnostic_directory"; then printf "npm diagnostic cleanup failed\\n" >&2; fi\' EXIT',
  '  umask "$caller_umask"',
  "",
  '  cd "$working_directory"',
  "  command=(env",
  "    -u COMPATIBLE_API_KEY -u GH_TOKEN -u GITHUB_TOKEN",
  "    -u NVIDIA_INFERENCE_API_KEY -u NODE_AUTH_TOKEN -u NPM_CONFIG__AUTH_TOKEN -u NPM_TOKEN",
  "    NO_COLOR=1 npm_config_color=false npm_config_loglevel=verbose npm_config_logs_max=0)",
  "  npm_command=(npm install --ignore-scripts)",
  '  if [[ "$stage" == "reviewed-npm" ]]; then',
  '    command=(sudo "${command[@]}" "RUNNER_TEMP=$reviewed_npm_tmp")',
  "    npm_command=(bash .github/actions/setup-reviewed-npm/verify-and-install-npm.sh ci/reviewed-npm-audit.json)",
  "  fi",
  "",
  "  set +e",
  '  "${command[@]}" "${npm_command[@]}" 2>&1 \\',
  "    | sanitize_npm_diagnostics \\",
  '    | bounded_npm_diagnostic_excerpt "$MAX_EXCERPT_BYTES" >"$command_log"',
  '  pipeline_status=("${PIPESTATUS[@]}")',
  "  set -e",
  '  readonly status="${pipeline_status[0]}"',
  '  if [[ "${pipeline_status[1]}" -ne 0 || "${pipeline_status[2]}" -ne 0 ]]; then',
  '    : >"$command_log"',
  "    printf 'npm command diagnostic sanitization or capture failed\\n' >&2",
  "  fi",
  '  if [[ "$status" -eq 0 ]]; then',
  '    tail -3 "$command_log"',
  "    exit 0",
  "  fi",
  '  if [[ "$stage" == "reviewed-npm" ]]; then',
  "    printf 'reviewed npm bootstrap failed (exit %s).\\n' \"$status\" >&2",
  "  else",
  '    printf \'npm install failed during %s dependency installation (exit %s).\\n\' "$stage" "$status" >&2',
  "  fi",
  "  printf '%s\\n' '--- npm command output ---' >&2",
  '  if [[ -s "$command_log" ]]; then',
  '    cat "$command_log" >&2',
  "  else",
  "    printf 'npm command output unavailable\\n' >&2",
  "  fi",
  '  exit "$status"',
  ")",
  "",
].join("\n");
export function prospectiveIssue12192BrevTemplate(source: string): string {
  const replaceRequired = (
    candidate: string,
    current: string,
    replacement: string,
    label: string,
  ): string => {
    const next = candidate.replace(current, replacement);
    assert.notEqual(next, candidate, label);
    return next;
  };

  const headerStart = source.indexOf("#\n# Brev launchable startup script");
  const headerEnd = source.indexOf("\nset -euo pipefail", headerStart);
  assert.notEqual(headerStart, -1, "prospective template header start");
  assert.notEqual(headerEnd, -1, "prospective template header end");
  let candidate = `${source.slice(0, headerStart)}#\n# Standalone Brev CPU bootstrap for Docker, reviewed Node/npm, OpenShell, and NemoClaw.\n#\n${source.slice(headerEnd)}`;

  candidate = replaceRequired(
    candidate,
    "# ── Configuration ────────────────────────────────────────────────────\n",
    "",
    "configuration divider",
  );
  candidate = replaceRequired(candidate, "# Logging\n", "", "logging heading");
  candidate = replaceRequired(
    candidate,
    "# ── Suppress apt noise ───────────────────────────────────────────────\n",
    "",
    "apt divider",
  );
  candidate = replaceRequired(
    candidate,
    "# ── Retry helper ─────────────────────────────────────────────────────\n",
    "",
    "retry divider",
  );
  candidate = replaceRequired(
    candidate,
    '# Usage: retry 3 10 "description" command arg1 arg2\n',
    "",
    "retry usage comment",
  );
  candidate = replaceRequired(candidate, "# Wait for apt locks.\n", "", "apt lock heading");
  candidate = replaceRequired(
    candidate,
    "# ══════════════════════════════════════════════════════════════════════\n# 1. System packages",
    "# 1. System packages",
    "system packages divider",
  );
  candidate = replaceRequired(
    candidate,
    "# The current bootstrap process predates the usermod above, so any Docker\n# daemon command in this session must use `sg docker -c ...`. New SSH sessions\n# naturally receive the docker group. Never weaken the host-root-equivalent\n# Docker socket permissions to work around stale group membership.",
    "# New Docker group membership takes effect in a new login session.",
    "Docker group explanation",
  );
  candidate = replaceRequired(
    candidate,
    '# --ignore-scripts above skips the `prepare` lifecycle which normally\n# builds dist/ (via `build:cli`). Build it explicitly — bin/nemoclaw.js\n# does `require("../dist/nemoclaw")` and needs the compiled output.',
    "# Build explicitly because --ignore-scripts skips prepare.",
    "explicit build explanation",
  );
  candidate = replaceRequired(
    candidate,
    "# Expose the nemoclaw CLI on PATH. Earlier this was `sudo npm link`, but\n# on cold CPU Brev that routinely hangs inside npm's global-prefix\n# housekeeping and `sudo chown -R node_modules` traversal (≥20 min in\n# CI). npm link just creates two symlinks in the end; do them directly\n# so setup stays deterministic and fast.",
    "# Link the compiled CLI without npm's global-prefix housekeeping.",
    "CLI link explanation",
  );
  candidate = replaceRequired(
    candidate,
    "# ══════════════════════════════════════════════════════════════════════\n# 6. Readiness sentinel\n# ══════════════════════════════════════════════════════════════════════",
    "# 6. Readiness sentinel",
    "readiness divider",
  );
  const withDiagnostics = candidate.replace(
    "\nassert_openshell_version() {",
    () => `\n${ISSUE_12192_NPM_DIAGNOSTICS}\nassert_openshell_version() {`,
  );
  assert.notEqual(withDiagnostics, candidate, "npm diagnostics template insertion");

  const withNodeReplacement = withDiagnostics.replace(
    '  sudo tar -xzf "$node_tmp" -C /usr/local --strip-components=1 --no-same-owner',
    [
      "  # The archive does not delete files left by the bundled npm from an older Node release.",
      "  sudo rm -rf /usr/local/lib/node_modules/npm",
      '  sudo tar -xzf "$node_tmp" -C /usr/local --strip-components=1 --no-same-owner',
    ].join("\n"),
  );
  assert.notEqual(withNodeReplacement, withDiagnostics, "stale npm replacement");

  const reviewedNpmBootstrap = [
    "sudo env -u NODE_AUTH_TOKEN -u NPM_TOKEN -u NPM_CONFIG__AUTH_TOKEN \\",
    '  RUNNER_TEMP="$reviewed_npm_tmp" \\',
    "  bash .github/actions/setup-reviewed-npm/verify-and-install-npm.sh ci/reviewed-npm-audit.json",
  ].join("\n");
  const withReviewedNpmDiagnostics = withNodeReplacement.replace(
    reviewedNpmBootstrap,
    'run_npm_install_with_diagnostics reviewed-npm "$NEMOCLAW_CLONE_DIR"',
  );
  assert.notEqual(
    withReviewedNpmDiagnostics,
    withNodeReplacement,
    "reviewed npm diagnostic wrapper",
  );

  const withRootNpmDiagnostics = withReviewedNpmDiagnostics.replace(
    "npm install --ignore-scripts 2>&1 | tail -3",
    'run_npm_install_with_diagnostics root "$NEMOCLAW_CLONE_DIR"',
  );
  assert.notEqual(
    withRootNpmDiagnostics,
    withReviewedNpmDiagnostics,
    "root npm diagnostic wrapper",
  );

  const withPluginNpmDiagnostics = withRootNpmDiagnostics.replace(
    "npm install --ignore-scripts 2>&1 | tail -3",
    'run_npm_install_with_diagnostics plugin "$NEMOCLAW_CLONE_DIR/nemoclaw"',
  );
  assert.notEqual(
    withPluginNpmDiagnostics,
    withRootNpmDiagnostics,
    "plugin npm diagnostic wrapper",
  );
  return withPluginNpmDiagnostics;
}
