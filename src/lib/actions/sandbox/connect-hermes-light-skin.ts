// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../../adapters/openshell/sandbox-command";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { R, YW } from "../../cli/terminal-style";
import { shellQuote } from "../../core/shell-quote";
import {
  applyHermesLightSkinConfig,
  hermesConfigUsesManagedLightSkin,
  NEMOCLAW_HERMES_LIGHT_SKIN_YAML,
  removeHermesLightSkinConfig,
  shouldApplyHermesLightSkin,
  shouldInspectHermesLightSkinConfig,
  shouldRemoveHermesLightSkin,
} from "../../domain/sandbox/connect-env";
import { readSandboxConfig, resolveAgentConfig, writeSandboxConfig } from "../../sandbox/config";
import { redact } from "../../security/redact";

type ConnectAgent = { name?: string } | null | undefined;

function encodeForSandboxWrite(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function warnHermesLightSkinFailure(action: string, error: unknown): void {
  const detail = error instanceof Error && error.message ? `: ${redact(error.message)}` : "";
  console.error(`  ${YW}⚠${R} Could not ${action} Hermes light terminal skin${detail}`);
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

async function runHermesLightSkinScript(
  action: "write" | "remove",
  sandboxName: string,
  script: string,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<boolean> {
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
    warnHermesLightSkinFailure(action, error);
    return false;
  }
  if (commandSucceeded(completion)) return true;
  warnHermesLightSkinFailure(action, commandFailure(completion));
  return false;
}

async function writeHermesLightSkinFile(
  sandboxName: string,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<boolean> {
  const skinB64 = encodeForSandboxWrite(NEMOCLAW_HERMES_LIGHT_SKIN_YAML);
  const script = [
    "set -eu",
    'hermes_home="${HERMES_HOME:-/sandbox/.hermes}"',
    'skin_dir="$hermes_home/skins"',
    'mkdir -p "$skin_dir"',
    'tmp="$(mktemp "$skin_dir/.nemoclaw-light.XXXXXX")"',
    "trap 'rm -f \"$tmp\"' EXIT",
    `printf %s ${shellQuote(skinB64)} | base64 -d > "$tmp"`,
    'chmod 640 "$tmp"',
    'mv -f "$tmp" "$skin_dir/nemoclaw-light.yaml"',
    'chown sandbox:sandbox "$skin_dir/nemoclaw-light.yaml" 2>/dev/null || true',
  ].join("\n");
  return runHermesLightSkinScript("write", sandboxName, script, commandExecutor);
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
  return runHermesLightSkinScript("remove", sandboxName, script, commandExecutor);
}

export async function prepareHermesLightTerminalSkin(
  sandboxName: string,
  agent: ConnectAgent,
  env: NodeJS.ProcessEnv,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<void> {
  if (agent?.name !== "hermes") return;
  if (!shouldInspectHermesLightSkinConfig(agent, env)) return;

  const target = resolveAgentConfig(sandboxName);
  if (target.agentName !== "hermes") return;

  let config: ReturnType<typeof readSandboxConfig>;
  try {
    config = readSandboxConfig(sandboxName, target);
  } catch (error) {
    warnHermesLightSkinFailure("read", error);
    return;
  }

  if (shouldRemoveHermesLightSkin(agent, env, config)) {
    if (!removeHermesLightSkinConfig(config)) return;
    try {
      writeSandboxConfig(sandboxName, target, config);
    } catch (error) {
      warnHermesLightSkinFailure("update", error);
      return;
    }
    if (!(await removeHermesLightSkinFile(sandboxName, commandExecutor))) return;
    return;
  }

  if (!shouldApplyHermesLightSkin(agent, env, config)) return;
  const changed = applyHermesLightSkinConfig(config);
  if (!changed && !hermesConfigUsesManagedLightSkin(config)) return;
  if (!(await writeHermesLightSkinFile(sandboxName, commandExecutor))) return;
  if (!changed) return;

  try {
    writeSandboxConfig(sandboxName, target, config);
  } catch (error) {
    warnHermesLightSkinFailure("update", error);
    if (!(await removeHermesLightSkinFile(sandboxName, commandExecutor))) return;
  }
}
