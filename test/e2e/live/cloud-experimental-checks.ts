// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import path from "node:path";

import { expect } from "vitest";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import {
  DCODE_BASE_IMAGE_ENV,
  requireDcodeBaseImageReference,
} from "../fixtures/dcode-base-image.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
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
const TUI_MODEL_TURN_TIMEOUT_MS = 20 * 60_000;
const THREAD_AUTO_APPROVAL_TIMEOUT_MS = 35 * 60_000;
const TUI_CALLER_RECOVERY_TIMEOUT_MS = 45_000;
const TUI_SESSION_ID_ENV = "NEMOCLAW_TUI_SESSION_ID";
const DCODE_PROCESS_COUNT_MARKER = "NEMOCLAW_DCODE_PROCESS_COUNT:";
const TUI_CALLER_RECOVERY_MARKER = "NEMOCLAW_TUI_CALLER_RECOVERY_OK:";
const DCODE_TUI_SESSION_GUARD = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/dcode-tui-session-guard.sh",
);

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
  options: { dcodeBaseImageReference?: string; forwardDcodeBaseImage?: boolean } = {},
): NodeJS.ProcessEnv {
  const candidateDcodeBaseImage =
    options.dcodeBaseImageReference ?? base[DCODE_BASE_IMAGE_ENV]?.trim();
  const dcodeBaseImage =
    base.E2E_WORKLOAD_SOURCE !== "managed-image" &&
    options.forwardDcodeBaseImage &&
    candidateDcodeBaseImage
      ? requireDcodeBaseImageReference({ [DCODE_BASE_IMAGE_ENV]: candidateDcodeBaseImage })
      : undefined;
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
    ...(dcodeBaseImage ? { [DCODE_BASE_IMAGE_ENV]: dcodeBaseImage } : {}),
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
  if (scriptPath === DEEPAGENTS_CODE_TUI_CHECK) return TUI_MODEL_TURN_TIMEOUT_MS;
  if (scriptPath === DEEPAGENTS_THREAD_AUTO_APPROVAL_CHECK) {
    return THREAD_AUTO_APPROVAL_TIMEOUT_MS;
  }
  return DEFAULT_CHECK_TIMEOUT_MS;
}

function processCountFromResult(label: string, result: ShellProbeResult): number | Error {
  const output = resultText(result);
  if (result.exitCode !== 0 || result.timedOut || result.signal) {
    return new Error(`${label} failed: ${output || `exit=${result.exitCode ?? "unknown"}`}`);
  }
  const counts = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(DCODE_PROCESS_COUNT_MARKER))
    .map((line) => line.slice(DCODE_PROCESS_COUNT_MARKER.length));
  const count = counts.at(-1);
  if (!count || !/^\d+$/u.test(count)) {
    return new Error(`${label} did not report a DCode process count: ${output}`);
  }
  return Number(count);
}

async function captureDcodeProcessBaseline(
  sandboxName: string,
  context: Pick<E2ETargetFixtures, "host">,
): Promise<number> {
  const result = await context.host.command(
    "bash",
    [DCODE_TUI_SESSION_GUARD, "baseline", sandboxName],
    {
      artifactName: "cloud-experimental-dcode-process-baseline",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const count = processCountFromResult("capture the pre-TUI DCode process baseline", result);
  return count instanceof Error ? Promise.reject(count) : count;
}

async function cleanupFailedTuiSession(
  sandboxName: string,
  sessionId: string,
  baseline: number,
  context: Pick<E2ETargetFixtures, "host">,
): Promise<void> {
  const result = await context.host.command(
    "bash",
    [DCODE_TUI_SESSION_GUARD, "recover", sandboxName, sessionId, String(baseline)],
    {
      artifactName: "cloud-experimental-dcode-tui-caller-recovery",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: TUI_CALLER_RECOVERY_TIMEOUT_MS,
    },
  );
  const remainingCount = processCountFromResult("clean up the failed DCode TUI session", result);
  if (remainingCount instanceof Error) return Promise.reject(remainingCount);
  const output = resultText(result);
  if (!output.includes(`${TUI_CALLER_RECOVERY_MARKER}${remainingCount}`)) {
    return Promise.reject(
      new Error(`clean up the failed DCode TUI session did not confirm completion: ${output}`),
    );
  }
}

async function runDcodeTuiCheck(
  sandboxName: string,
  scriptPath: string,
  apiKey: string,
  context: Pick<E2ETargetFixtures, "cleanup" | "host"> & {
    dcodeBaseImageReference?: string;
  },
): Promise<ShellProbeResult> {
  const baseline = await captureDcodeProcessBaseline(sandboxName, context);
  const sessionId = randomUUID();
  let recoveryArmed = true;
  let recoveryAttempt: Promise<void> | undefined;
  const recover = async (): Promise<void> => {
    if (!recoveryArmed) return;
    recoveryAttempt ??= cleanupFailedTuiSession(sandboxName, sessionId, baseline, context);
    try {
      await recoveryAttempt;
      recoveryArmed = false;
    } finally {
      recoveryAttempt = undefined;
    }
  };
  context.cleanup.add(`clean up failed DCode TUI session ${sessionId}`, recover);

  let result: ShellProbeResult;
  try {
    result = await context.host.command("bash", [path.join(REPO_ROOT, scriptPath)], {
      artifactName: `cloud-experimental-${path.basename(scriptPath, ".sh")}`,
      cwd: REPO_ROOT,
      env: {
        ...buildCloudExperimentalCommandEnv(sandboxName, apiKey, process.env, {
          dcodeBaseImageReference: context.dcodeBaseImageReference,
        }),
        [TUI_SESSION_ID_ENV]: sessionId,
      },
      redactionValues: [apiKey],
      timeoutMs: cloudExperimentalCheckTimeoutMs(scriptPath),
    });
  } catch (error) {
    try {
      await recover();
    } catch (recoveryError) {
      return Promise.reject(
        new AggregateError(
          [error, recoveryError],
          "DCode TUI check failed, and its sandbox process cleanup did not complete",
        ),
      );
    }
    return Promise.reject(error);
  }
  if (result.exitCode === 0 && !result.timedOut && !result.signal) {
    recoveryArmed = false;
  } else {
    await recover();
  }
  return result;
}

export async function runE2eCloudExperimentalChecks(
  targetId: string,
  sandboxName: string,
  checkScripts: readonly string[],
  context: Pick<E2ETargetFixtures, "artifacts" | "cleanup" | "host" | "secrets"> & {
    dcodeBaseImageReference?: string;
  },
): Promise<void> {
  const apiKey = context.secrets.optional("NVIDIA_INFERENCE_API_KEY") ?? "";
  await context.artifacts.writeJson(
    "e2e-cloud-experimental-checks.json",
    buildCloudExperimentalChecksEvidence(targetId, sandboxName, checkScripts),
  );
  if (checkScripts.length > 0) {
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
    expect(result.exitCode, `Deep Agents Code runtime marker missing: ${resultText(result)}`).toBe(
      0,
    );
  }
  for (const scriptPath of checkScripts) {
    const result =
      scriptPath === DEEPAGENTS_CODE_TUI_CHECK
        ? await runDcodeTuiCheck(sandboxName, scriptPath, apiKey, context)
        : await context.host.command("bash", [path.join(REPO_ROOT, scriptPath)], {
            artifactName: `cloud-experimental-${path.basename(scriptPath, ".sh")}`,
            cwd: REPO_ROOT,
            env: buildCloudExperimentalCommandEnv(sandboxName, apiKey, process.env, {
              dcodeBaseImageReference: context.dcodeBaseImageReference,
              forwardDcodeBaseImage: scriptPath === DEEPAGENTS_FRESH_REONBOARD_CHECK,
            }),
            redactionValues: [apiKey],
            timeoutMs: cloudExperimentalCheckTimeoutMs(scriptPath),
          });
    assertRequiredCloudExperimentalResult(scriptPath, result);
    if (
      scriptPath === DEEPAGENTS_FRESH_REONBOARD_CHECK &&
      process.env.E2E_WORKLOAD_SOURCE === "managed-image"
    ) {
      assertStockManagedImageReceipt({ sandboxName, expectedAgent: "langchain-deepagents-code" });
    }
  }
}
