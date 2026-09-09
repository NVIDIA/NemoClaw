// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REQUIRED_OPENSHELL_MCP_FEATURES } from "../../../src/lib/onboard/openshell-feature-gate";

export const HERMES_GPU_FALLBACK_EVENTS = {
  rejectNativeCreateBeforeProgress: "reject-native-create-before-progress",
  delegateCompatibilityCreate: "delegate-compatibility-create",
  commitCompatibilityHandoff: "commit-compatibility-handoff",
} as const;

export const HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF = [
  "set -eu;",
  "if command -v nvidia-smi >/dev/null 2>&1; then",
  "exec nvidia-smi;",
  "fi;",
  'echo "nvidia-smi not installed; skipping optional visibility check"',
].join(" ");

export interface HermesGpuFallbackWrapper {
  componentEnv: NodeJS.ProcessEnv;
  eventsPath: string;
  rootDir: string;
  wrapperPath: string;
}

export type HermesGpuStartupScenario = "compatibility-only" | "fallback" | "native";
export type HermesGpuStartupRoute =
  | "compatibility-fallback"
  | "compatibility-only"
  | "native-success";

export function resolveHermesGpuStartupScenario(
  rawScenario: string | undefined,
  forceCompatibility: boolean,
): { route: HermesGpuStartupRoute; scenario: HermesGpuStartupScenario } {
  const scenario = rawScenario ?? "native";
  if (scenario !== "native" && scenario !== "fallback" && scenario !== "compatibility-only") {
    throw new Error(
      `E2E_HERMES_GPU_STARTUP_SCENARIO must be native, fallback, or compatibility-only, got '${scenario}'`,
    );
  }
  if (scenario === "fallback" && forceCompatibility) {
    throw new Error(
      "fallback scenario requires automatic GPU routing, not compatibility-only mode",
    );
  }
  return {
    scenario,
    route:
      forceCompatibility || scenario === "compatibility-only"
        ? "compatibility-only"
        : scenario === "fallback"
          ? "compatibility-fallback"
          : "native-success",
  };
}

export function extractHermesGpuDiagnosticsDirectory(output: string): string {
  return (
    output.match(/Pre-rollback diagnostics saved:\s*(\S+)/u)?.[1] ??
    output.match(/Native GPU diagnostics saved:\s*(\S+)/u)?.[1] ??
    ""
  );
}

function requireAbsoluteExecutable(filePath: string, label: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  fs.accessSync(filePath, fs.constants.X_OK);
}

function quoteShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Create an E2E-only OpenShell CLI wrapper that rejects the exact native
 * `--gpu` create before build or sandbox progress. The compatibility create
 * runs the real CLI while the rejecting wrapper stays installed. A normal
 * success, or NemoClaw's expected termination after the sandbox is independently
 * proven Ready, atomically replaces the wrapper with a real-CLI link. A failed
 * or pre-Ready interrupted invocation never changes the wrapper path; an
 * overlapping successful invocation may independently commit the link and
 * remains authoritative. Every other invocation transparently delegates its
 * original argv. This
 * test-only wrapper never logs argv: its sole artifact is an event log made of
 * fixed labels, so sandbox-create environment arguments never enter artifacts.
 * This interception pattern is specific to the #6110 fallback proof and must
 * not be copied to another E2E path without security review. The caller owns
 * the wrapper root and registers recursive removal with the test cleanup stack.
 */
export function createHermesGpuFallbackWrapper(
  realOpenshellPath: string,
  options: { rootDir?: string } = {},
): HermesGpuFallbackWrapper {
  requireAbsoluteExecutable(realOpenshellPath, "real OpenShell CLI");
  const componentDir = path.dirname(realOpenshellPath);
  const gatewayPath = path.join(componentDir, "openshell-gateway");
  const sandboxPath = path.join(componentDir, "openshell-sandbox");
  requireAbsoluteExecutable(gatewayPath, "OpenShell gateway component");
  requireAbsoluteExecutable(sandboxPath, "OpenShell sandbox component");

  const rootDir =
    options.rootDir ??
    fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "hermes-gpu-fallback-"));
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const stateDir = path.join(rootDir, "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const wrapperPath = path.join(rootDir, "openshell");
  const eventsPath = path.join(stateDir, "events.log");
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    ...REQUIRED_OPENSHELL_MCP_FEATURES.map((marker) => `# capability: ${marker}`),
    `REAL_OPENSHELL=${quoteShellLiteral(realOpenshellPath)}`,
    `FALLBACK_STATE_DIR=${quoteShellLiteral(stateDir)}`,
    "COMPATIBILITY_SIGNAL_TIMEOUT_SECONDS=2",
    "READY_QUERY_TIMEOUT_SECONDS=2",
    'NATIVE_CREATE_REJECTED="$FALLBACK_STATE_DIR/native-create-rejected"',
    `SANDBOX_NAME="$(printf '%s\\n' "$@" | awk 'previous == "--name" { print; exit } /^--name=/ { sub(/^--name=/, ""); print; exit } /^NEMOCLAW_SANDBOX_NAME=/ { sub(/^NEMOCLAW_SANDBOX_NAME=/, ""); print; exit } { previous = $0 }')"`,
    "",
    "commit_compatibility_handoff() {",
    '  REAL_OPENSHELL_LINK="$FALLBACK_STATE_DIR/openshell-real.$$"',
    '  ln -s "$REAL_OPENSHELL" "$REAL_OPENSHELL_LINK"',
    '  mv -f "$REAL_OPENSHELL_LINK" "$0"',
    `  printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.commitCompatibilityHandoff}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "}",
    "",
    "sandbox_is_ready() {",
    '  READY_QUERY_OUTPUT="$FALLBACK_STATE_DIR/sandbox-ready.$$"',
    '  (exec "$REAL_OPENSHELL" sandbox get "$SANDBOX_NAME") >"$READY_QUERY_OUTPUT" 2>/dev/null &',
    '  ready_query_pid="$!"',
    "  (",
    '    sleep "$READY_QUERY_TIMEOUT_SECONDS"',
    '    kill -TERM "$ready_query_pid" 2>/dev/null || true',
    "    sleep 0.2",
    '    kill -KILL "$ready_query_pid" 2>/dev/null || true',
    "  ) &",
    '  ready_watchdog_pid="$!"',
    "  ready_query_status=0",
    '  wait "$ready_query_pid" || ready_query_status="$?"',
    '  kill "$ready_watchdog_pid" 2>/dev/null || true',
    '  wait "$ready_watchdog_pid" 2>/dev/null || true',
    '  test "$ready_query_status" -eq 0 &&',
    "    grep -Eq '(^|[[:space:]])Ready([[:space:]]|$)' \"$READY_QUERY_OUTPUT\"",
    '  ready_query_status="$?"',
    '  rm -f "$READY_QUERY_OUTPUT"',
    '  return "$ready_query_status"',
    "}",
    "",
    "is_sandbox_create=0",
    "has_gpu_flag=0",
    'if [[ "${1:-}" == "sandbox" && "${2:-}" == "create" ]]; then',
    "  is_sandbox_create=1",
    '  for arg in "$@"; do',
    '    if [[ "$arg" == "--gpu" ]]; then',
    "      has_gpu_flag=1",
    "      break",
    "    fi",
    "  done",
    "fi",
    "",
    'if [[ "$is_sandbox_create" == "1" ]]; then',
    '  if [[ "$has_gpu_flag" == "1" ]]; then',
    '    if mkdir "$NATIVE_CREATE_REJECTED" 2>/dev/null; then',
    `      printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreateBeforeProgress}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "    fi",
    `    printf '%s\\n' "error: unexpected argument '--gpu' found" >&2`,
    "    exit 2",
    "  else",
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate}' >>"$FALLBACK_STATE_DIR/events.log"`,
    '    COMPATIBILITY_PID=""',
    "    forward_compatibility_signal() {",
    '      local signal="$1"',
    '      local status="$2"',
    "      trap - HUP INT TERM",
    '      if [[ -n "$COMPATIBILITY_PID" ]] && kill -0 "$COMPATIBILITY_PID" 2>/dev/null; then',
    '        kill "-$signal" "$COMPATIBILITY_PID" 2>/dev/null || true',
    "      fi",
    "      (",
    '        sleep "$COMPATIBILITY_SIGNAL_TIMEOUT_SECONDS"',
    '        kill -KILL "$COMPATIBILITY_PID" 2>/dev/null || true',
    "      ) &",
    '      compatibility_watchdog_pid="$!"',
    '      wait "$COMPATIBILITY_PID" 2>/dev/null || true',
    '      kill "$compatibility_watchdog_pid" 2>/dev/null || true',
    '      wait "$compatibility_watchdog_pid" 2>/dev/null || true',
    "      sandbox_is_ready && commit_compatibility_handoff || true",
    '      exit "$status"',
    "    }",
    "    trap 'forward_compatibility_signal HUP 129' HUP",
    "    trap 'forward_compatibility_signal INT 130' INT",
    "    trap 'forward_compatibility_signal TERM 143' TERM",
    '    (exec "$REAL_OPENSHELL" "$@") &',
    '    COMPATIBILITY_PID="$!"',
    '    wait "$COMPATIBILITY_PID" || {',
    '      compatibility_status="$?"',
    "      trap - HUP INT TERM",
    '      exit "$compatibility_status"',
    "    }",
    "    trap - HUP INT TERM",
    "    commit_compatibility_handoff",
    "    exit 0",
    "  fi",
    "fi",
    "",
    "# Transparent test-only delegation: argv is never written by this wrapper.",
    'exec "$REAL_OPENSHELL" "$@"',
    "",
  ].join("\n");
  fs.writeFileSync(wrapperPath, wrapper, { encoding: "utf8", mode: 0o700 });

  return {
    componentEnv: {
      NEMOCLAW_OPENSHELL_BIN: wrapperPath,
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: gatewayPath,
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: sandboxPath,
    },
    eventsPath,
    rootDir,
    wrapperPath,
  };
}

export function readHermesGpuFallbackEvents(eventsPath: string): string[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}
