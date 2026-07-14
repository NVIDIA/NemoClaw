// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
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

function writeHermesLightSkinFile(sandboxName: string): boolean {
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
  const result = runOpenshell(["sandbox", "exec", "--name", sandboxName, "--", "sh", "-s"], {
    ignoreError: true,
    input: script,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.status === 0 && !result.error && !result.signal) return true;
  warnHermesLightSkinFailure("write", result.error ?? `exit ${result.status ?? result.signal}`);
  return false;
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

export function prepareHermesLightTerminalSkin(
  sandboxName: string,
  agent: ConnectAgent,
  env: NodeJS.ProcessEnv,
): void {
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
    if (!removeHermesLightSkinFile(sandboxName)) return;
    return;
  }

  if (!shouldApplyHermesLightSkin(agent, env, config)) return;
  const changed = applyHermesLightSkinConfig(config);
  if (!changed && !hermesConfigUsesManagedLightSkin(config)) return;
  if (!writeHermesLightSkinFile(sandboxName)) return;
  if (!changed) return;

  try {
    writeSandboxConfig(sandboxName, target, config);
  } catch (error) {
    warnHermesLightSkinFailure("update", error);
    if (!removeHermesLightSkinFile(sandboxName)) return;
  }
}
