// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REQUIRED_OPENSHELL_MCP_FEATURES } from "../../../src/lib/onboard/openshell-feature-gate";

export const HERMES_GPU_FALLBACK_EVENTS = {
  delegateNativeCreateWithoutGpu: "delegate-native-create-without-gpu",
  rejectNativeNvidiaSmiProof: "reject-native-nvidia-smi-proof",
  delegateCompatibilityCreate: "delegate-compatibility-create",
  delegateNvidiaSmiProofAfterRejection: "delegate-nvidia-smi-proof-after-rejection",
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
 * Create an E2E-only OpenShell CLI wrapper that simulates a native injector
 * silently dropping the exact `--gpu` request while still delegating creation,
 * so a real partial sandbox exists with host-visible GPU attachment absent.
 * It then atomically rejects the first exact post-create `nvidia-smi` proof
 * with a narrow NVML driver error. Every other invocation transparently
 * delegates its original argv to the real CLI. This
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
    `NATIVE_NVIDIA_SMI_PROOF=${quoteShellLiteral(HERMES_GPU_NATIVE_NVIDIA_SMI_PROOF)}`,
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
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreateWithoutGpu}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "    filtered_args=()",
    "    stripped_gpu=0",
    '    for arg in "$@"; do',
    '      if [[ "$stripped_gpu" == "0" && "$arg" == "--gpu" ]]; then',
    "        stripped_gpu=1",
    "        continue",
    "      fi",
    '      filtered_args+=("$arg")',
    "    done",
    '    exec "$REAL_OPENSHELL" "${filtered_args[@]}"',
    "  else",
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "  fi",
    "fi",
    "",
    "is_native_nvidia_smi_proof=0",
    'if [[ "$#" -eq 8 && "${1:-}" == "sandbox" && "${2:-}" == "exec" && "${3:-}" == "-n" && -n "${4:-}" && "${5:-}" == "--" && "${6:-}" == "sh" && "${7:-}" == "-lc" && "${8:-}" == "$NATIVE_NVIDIA_SMI_PROOF" ]]; then',
    "  is_native_nvidia_smi_proof=1",
    "fi",
    "",
    'if [[ "$is_native_nvidia_smi_proof" == "1" ]]; then',
    '  if mkdir "$FALLBACK_STATE_DIR/native-nvidia-smi-proof-rejected" 2>/dev/null; then',
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.rejectNativeNvidiaSmiProof}' >>"$FALLBACK_STATE_DIR/events.log"`,
    `    printf '%s\\n' 'Failed to initialize NVML: Driver/library version mismatch' >&2`,
    "    exit 1",
    "  fi",
    `  printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateNvidiaSmiProofAfterRejection}' >>"$FALLBACK_STATE_DIR/events.log"`,
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
