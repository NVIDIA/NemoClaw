// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REQUIRED_OPENSHELL_MCP_FEATURES } from "../../../src/lib/onboard/openshell-feature-gate";

export const HERMES_GPU_FALLBACK_EVENTS = {
  rejectNativeCreate: "reject-native-create",
  delegateNativeCreate: "delegate-native-create-after-rejection",
  delegateCompatibilityCreate: "delegate-compatibility-create",
} as const;

export interface HermesGpuFallbackWrapper {
  componentEnv: NodeJS.ProcessEnv;
  eventsPath: string;
  rootDir: string;
  wrapperPath: string;
}

export type HermesGpuStartupScenario = "fallback" | "native";
export type HermesGpuStartupRoute =
  | "compatibility-fallback"
  | "compatibility-only"
  | "native-success";

export function resolveHermesGpuStartupScenario(
  rawScenario: string | undefined,
  forceCompatibility: boolean,
): { route: HermesGpuStartupRoute; scenario: HermesGpuStartupScenario } {
  const scenario = rawScenario ?? "native";
  if (scenario !== "native" && scenario !== "fallback") {
    throw new Error(
      `E2E_HERMES_GPU_STARTUP_SCENARIO must be native or fallback, got '${scenario}'`,
    );
  }
  if (scenario === "fallback" && forceCompatibility) {
    throw new Error(
      "fallback scenario requires automatic GPU routing, not compatibility-only mode",
    );
  }
  return {
    scenario,
    route: forceCompatibility
      ? "compatibility-only"
      : scenario === "fallback"
        ? "compatibility-fallback"
        : "native-success",
  };
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
 * Create an E2E-only OpenShell CLI wrapper that models a native `--gpu`
 * rejection. The first matching create is rejected atomically; every later
 * invocation delegates to the real CLI. The event log contains fixed labels
 * only, so sandbox-create environment arguments never enter test artifacts.
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
    '    if mkdir "$FALLBACK_STATE_DIR/native-create-rejected" 2>/dev/null; then',
    `      printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.rejectNativeCreate}' >>"$FALLBACK_STATE_DIR/events.log"`,
    `      printf '%s\\n' "error: unexpected argument '--gpu' found" >&2`,
    "      exit 2",
    "    fi",
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateNativeCreate}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "  else",
    `    printf '%s\\n' '${HERMES_GPU_FALLBACK_EVENTS.delegateCompatibilityCreate}' >>"$FALLBACK_STATE_DIR/events.log"`,
    "  fi",
    "fi",
    "",
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
