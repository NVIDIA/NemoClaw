// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect } from "vitest";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  DEEPAGENTS_FRESH_REONBOARD_CHECK,
  DEEPAGENTS_OBSERVABILITY_CHECK,
  DEEPAGENTS_THREAD_AUTO_APPROVAL_CHECK,
} from "./cloud-experimental-check-list.ts";

const REQUIRED_CHECK_SKIP_PATTERN = /(^|\n).*\bSKIP\b/i;
const DEFAULT_CHECK_TIMEOUT_MS = 180_000;
const FRESH_REONBOARD_TIMEOUT_MS = 15 * 60_000;
const OBSERVABILITY_TIMEOUT_MS = 8 * 60_000;
const THREAD_AUTO_APPROVAL_TIMEOUT_MS = 35 * 60_000;

export type CloudExperimentalChecksEvidence = {
  targetId: string;
  sandboxName: string;
  checkScripts: readonly string[];
  terminalConnectHint?: {
    agent: string;
    interactiveCommand: string;
    statusLine: string;
    source: string;
  };
};

const DEEPAGENTS_CODE_ONBOARDING = "cloud-langchain-deepagents-code";
const DEEPAGENTS_CODE_TUI_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh";
const DEEPAGENTS_CODE_CONNECT_HINT = {
  agent: "langchain-deepagents-code",
  interactiveCommand: "dcode",
  statusLine: "Interactive: dcode",
  source: "agents/langchain-deepagents-code/manifest.yaml:runtime.interactive_command",
};

export function buildCloudExperimentalChecksEvidence(
  targetId: string,
  sandboxName: string,
  checkScripts: readonly string[],
): CloudExperimentalChecksEvidence {
  return {
    targetId,
    sandboxName,
    checkScripts,
    ...(targetId === DEEPAGENTS_CODE_ONBOARDING && checkScripts.includes(DEEPAGENTS_CODE_TUI_CHECK)
      ? { terminalConnectHint: DEEPAGENTS_CODE_CONNECT_HINT }
      : {}),
  };
}

export function buildCloudExperimentalCommandEnv(
  sandboxName: string,
  apiKey: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(base),
    CLOUD_EXPERIMENTAL_MODEL: base.NEMOCLAW_MODEL,
    COMPATIBLE_API_KEY: apiKey,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_E2E_CLOUD_API_KEY_ENV: "COMPATIBLE_API_KEY",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: "nemoclaw",
    REPO: REPO_ROOT,
    SANDBOX_NAME: sandboxName,
  };
}

export function assertRequiredCloudExperimentalResult(
  scriptPath: string,
  result: ShellProbeResult,
): void {
  const output = resultText(result);
  expect(result.exitCode, `${scriptPath}: ${output}`).toBe(0);
  expect(output, `${scriptPath}: required cloud-experimental check must not skip`).not.toMatch(
    REQUIRED_CHECK_SKIP_PATTERN,
  );
}

export function cloudExperimentalCheckTimeoutMs(scriptPath: string): number {
  if (scriptPath === DEEPAGENTS_FRESH_REONBOARD_CHECK) return FRESH_REONBOARD_TIMEOUT_MS;
  if (scriptPath === DEEPAGENTS_OBSERVABILITY_CHECK) return OBSERVABILITY_TIMEOUT_MS;
  if (scriptPath === DEEPAGENTS_THREAD_AUTO_APPROVAL_CHECK) {
    return THREAD_AUTO_APPROVAL_TIMEOUT_MS;
  }
  return DEFAULT_CHECK_TIMEOUT_MS;
}

async function assertDeepAgentsRuntimeObserved(
  sandboxName: string,
  context: Pick<E2ETargetFixtures, "host">,
): Promise<void> {
  const result = await context.host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "bash",
      "-c",
      "test -d /sandbox/.deepagents && command -v dcode >/dev/null",
    ],
    {
      artifactName: "cloud-experimental-deepagents-runtime",
      env: buildCloudExperimentalCommandEnv(sandboxName, ""),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, `Deep Agents Code runtime marker missing: ${resultText(result)}`).toBe(0);
}

export async function runE2eCloudExperimentalChecks(
  targetId: string,
  sandboxName: string,
  checkScripts: readonly string[],
  context: Pick<E2ETargetFixtures, "artifacts" | "host" | "secrets">,
): Promise<void> {
  const apiKey = context.secrets.optional("NVIDIA_INFERENCE_API_KEY") ?? "";
  await context.artifacts.writeJson(
    "e2e-cloud-experimental-checks.json",
    buildCloudExperimentalChecksEvidence(targetId, sandboxName, checkScripts),
  );
  await Promise.resolve(
    checkScripts.length > 0 ? assertDeepAgentsRuntimeObserved(sandboxName, context) : undefined,
  );
  for (const scriptPath of checkScripts) {
    const result = await context.host.command("bash", [path.join(REPO_ROOT, scriptPath)], {
      artifactName: `cloud-experimental-${path.basename(scriptPath, ".sh")}`,
      cwd: REPO_ROOT,
      env: buildCloudExperimentalCommandEnv(sandboxName, apiKey),
      redactionValues: [apiKey],
      timeoutMs: cloudExperimentalCheckTimeoutMs(scriptPath),
    });
    assertRequiredCloudExperimentalResult(scriptPath, result);
  }
}
