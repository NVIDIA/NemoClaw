// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect } from "vitest";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { E2EScenarioFixtures } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REQUIRED_CHECK_SKIP_PATTERN = /(^|\n).*\bSKIP\b/i;

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

async function assertDeepAgentsRuntimeObserved(
  sandboxName: string,
  context: Pick<E2EScenarioFixtures, "host">,
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
  scenarioId: string,
  sandboxName: string,
  checkScripts: readonly string[],
  context: Pick<E2EScenarioFixtures, "artifacts" | "host" | "secrets">,
): Promise<void> {
  const apiKey = context.secrets.optional("NVIDIA_INFERENCE_API_KEY") ?? "";
  await context.artifacts.writeJson("e2e-cloud-experimental-checks.json", {
    scenarioId,
    sandboxName,
    checkScripts,
  });
  await Promise.resolve(
    checkScripts.length > 0 ? assertDeepAgentsRuntimeObserved(sandboxName, context) : undefined,
  );
  for (const scriptPath of checkScripts) {
    const result = await context.host.command("bash", [path.join(REPO_ROOT, scriptPath)], {
      artifactName: `cloud-experimental-${path.basename(scriptPath, ".sh")}`,
      cwd: REPO_ROOT,
      env: buildCloudExperimentalCommandEnv(sandboxName, apiKey),
      redactionValues: [apiKey],
      timeoutMs: 180_000,
    });
    assertRequiredCloudExperimentalResult(scriptPath, result);
  }
}
