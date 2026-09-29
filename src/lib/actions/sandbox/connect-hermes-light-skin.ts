// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../../adapters/openshell/sandbox-command";
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

function commandSucceeded(completion: OpenShellSandboxBufferedCommandCompletion): boolean {
  return (
    completion.outcome.kind === "completed" &&
    completion.outcome.exitCode === 0 &&
    !completion.outcome.signal
  );
}

function commandFailure(completion: OpenShellSandboxBufferedCommandCompletion): unknown {
  if (completion.outcome.kind === "failed") return new Error(completion.outcome.error.message);
  return `exit ${completion.outcome.signal ?? completion.outcome.exitCode}`;
}

async function removeHermesLightSkinFile(
  sandboxName: string,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<boolean> {
  const script = [
    "set -eu",
    'hermes_home="${HERMES_HOME:-/sandbox/.hermes}"',
    'skin_dir="$hermes_home/skins"',
    'rm -f "$skin_dir/nemoclaw-light.yaml"',
  ].join("\n");
  let completion: OpenShellSandboxBufferedCommandCompletion;
  try {
    completion = await commandExecutor.runBuffered({
      sandboxName,
      target: { kind: "selected" },
      command: ["sh", "-s"],
      input: script,
      timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    warnHermesLightSkinFailure("remove", error);
    return false;
  }
  if (commandSucceeded(completion)) return true;
  warnHermesLightSkinFailure("remove", commandFailure(completion));
  return false;
}

/** Remove the NemoClaw light-skin shim that Hermes 0.21.3 replaced natively. */
export async function prepareHermesLightTerminalSkin(
  sandboxName: string,
  agent: ConnectAgent,
  _env: NodeJS.ProcessEnv,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<void> {
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
  await removeHermesLightSkinFile(sandboxName, commandExecutor);
}
