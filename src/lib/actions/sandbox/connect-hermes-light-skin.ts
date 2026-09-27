// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { R, YW } from "../../cli/terminal-style";
import {
  hermesConfigUsesManagedLightSkin,
  removeHermesLightSkinConfig,
} from "../../domain/sandbox/connect-env";
import { readSandboxConfig, resolveAgentConfig, writeSandboxConfig } from "../../sandbox/config";
import { redact } from "../../security/redact";

type ConnectAgent = { name?: string } | null | undefined;

function warnHermesLightSkinFailure(action: string, error: unknown): void {
  const detail = error instanceof Error && error.message ? `: ${redact(error.message)}` : "";
  console.error(`  ${YW}⚠${R} Could not ${action} retired Hermes light terminal skin${detail}`);
}

function removeHermesLightSkinFile(sandboxName: string): boolean {
  const script = [
    "set -eu",
    'hermes_home="${HERMES_HOME:-/sandbox/.hermes}"',
    'skin_dir="$hermes_home/skins"',
    'rm -f "$skin_dir/nemoclaw-light.yaml"',
  ].join("\n");
  const result = runOpenshell(["sandbox", "exec", "--name", sandboxName, "--", "sh", "-s"], {
    ignoreError: true,
    input: script,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.status === 0 && !result.error && !result.signal) return true;
  warnHermesLightSkinFailure("remove", result.error ?? `exit ${result.status ?? result.signal}`);
  return false;
}

/** Remove the NemoClaw light-skin shim that Hermes 0.21.3 replaced natively. */
export function prepareHermesLightTerminalSkin(
  sandboxName: string,
  agent: ConnectAgent,
  _env: NodeJS.ProcessEnv,
): void {
  if (agent?.name !== "hermes") return;

  const target = resolveAgentConfig(sandboxName);
  if (target.agentName !== "hermes") return;

  let config: ReturnType<typeof readSandboxConfig>;
  try {
    config = readSandboxConfig(sandboxName, target);
  } catch (error) {
    warnHermesLightSkinFailure("read", error);
    return;
  }

  if (!hermesConfigUsesManagedLightSkin(config)) return;
  if (!removeHermesLightSkinConfig(config)) return;
  try {
    writeSandboxConfig(sandboxName, target, config);
  } catch (error) {
    warnHermesLightSkinFailure("update", error);
    return;
  }
  removeHermesLightSkinFile(sandboxName);
}
