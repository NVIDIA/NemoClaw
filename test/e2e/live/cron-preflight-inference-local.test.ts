// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  DEFAULT_HOSTED_INFERENCE_MODEL,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cron-preflight";
const MODEL = process.env.NEMOCLAW_CRON_PREFLIGHT_MODEL ?? DEFAULT_HOSTED_INFERENCE_MODEL;

test(
  "native OpenClaw scheduled work reaches inference.local",
  {
    timeout: testTimeout(30 * 60_000),
    meta: {
      e2ePhases: [
        "prepare the native cron fixture",
        "onboard hosted-inference OpenClaw",
        "create native scheduled work",
        "run native scheduled work through inference",
        "remove the native cron fixture",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets, process.env, {
      model: MODEL,
    });
    const env = {
      ...buildAvailabilityProbeEnv(),
      ...hosted.env,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    };
    const redactions = [hosted.apiKey];

    await artifacts.target.declare({
      id: "cron-preflight-inference-local",
      boundary: "native OpenClaw cron add/run through managed inference.local",
      contracts: [
        "native OpenClaw creates scheduled work without NemoClaw lifecycle authorization",
        "native cron run passes its provider preflight and reaches inference.local",
        "the native command reports a completed or queued run without endpoint-unreachable errors",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "cron-preflight-runtime-provider",
      scenarioLabel: "native OpenClaw cron",
    });
    try {
      await sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cron-preflight-preclean-openshell-delete",
        env,
        timeoutMs: 120_000,
      });
    } catch {
      // The named gateway does not exist before first onboarding.
    }
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cron-preflight-cleanup-openshell-delete",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      }),
    );

    progress.phase("onboard hosted-inference OpenClaw");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "cron-preflight-install",
      cwd: REPO_ROOT,
      env,
      redactionValues: redactions,
      timeoutMs: execTimeout(20 * 60_000),
    });
    assertExitZero(install, "native cron install");

    progress.phase("create native scheduled work");
    const cronName = `nemoclaw-native-cron-${Date.now()}`;
    await sandbox.exec(
      SANDBOX_NAME,
      [
        "openclaw",
        "cron",
        "add",
        "--name",
        cronName,
        "--every",
        "2h",
        "--agent",
        "main",
        "--session",
        "isolated",
        "--message",
        "Reply with exactly PONG and no other text.",
      ],
      {
        artifactName: "cron-preflight-native-add",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      },
    );
    const devices = await sandbox.openshell(
      ["sandbox", "exec", "-n", SANDBOX_NAME, "--", "openclaw", "devices", "list", "--json"],
      {
        artifactName: "cron-preflight-native-devices-list",
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      },
    );
    const pending = (
      JSON.parse(devices.stdout) as {
        pending?: Array<{ id?: string; requestId?: string; scopes?: string[] }>;
      }
    ).pending;
    const request = pending?.find(({ scopes }) => scopes?.includes("operator.admin"));
    const requestId = String(request?.requestId ?? request?.id ?? "");
    const approve = await sandbox.openshell(
      [
        "sandbox",
        "exec",
        "-n",
        SANDBOX_NAME,
        "--",
        "openclaw",
        "devices",
        "approve",
        requestId,
        "--json",
      ],
      {
        artifactName: "cron-preflight-native-devices-approve",
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      },
    );
    assertExitZero(approve, "native OpenClaw device scope approval");
    const add = await sandbox.exec(
      SANDBOX_NAME,
      [
        "openclaw",
        "cron",
        "add",
        "--name",
        cronName,
        "--every",
        "2h",
        "--agent",
        "main",
        "--session",
        "isolated",
        "--message",
        "Reply with exactly PONG and no other text.",
      ],
      {
        artifactName: "cron-preflight-native-add-after-approval",
        env,
        redactionValues: redactions,
        timeoutMs: 120_000,
      },
    );
    assertExitZero(add, "native OpenClaw cron add");
    const cronId = findCronId(add.stdout, cronName);
    expect(cronId, resultText(add)).not.toBe("");

    progress.phase("run native scheduled work through inference");
    const run = await sandbox.exec(SANDBOX_NAME, ["openclaw", "cron", "run", cronId], {
      artifactName: "cron-preflight-native-run",
      env,
      redactionValues: redactions,
      timeoutMs: 5 * 60_000,
    });
    const runOutput = resultText(run);
    const runStdout = run.stdout;
    assertExitZero(run, "native OpenClaw cron run");
    expect(runOutput).not.toMatch(
      /EAI_AGAIN|local provider endpoint is not reachable|request timed out/iu,
    );
    expect(nativeCronRunAccepted(runStdout), runOutput).toBe(true);

    progress.phase("remove the native cron fixture");
    const remove = await sandbox.exec(SANDBOX_NAME, ["openclaw", "cron", "remove", cronId], {
      artifactName: "cron-preflight-native-remove",
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    });
    assertExitZero(remove, "native OpenClaw cron remove");

    await artifacts.target.complete({
      id: "cron-preflight-inference-local",
      status: "passed",
      nativeCronId: cronId,
      nativeRunAccepted: true,
      inferenceRoute: "https://inference.local/v1",
    });
  },
);

function decodedObjects(output: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") continue;
    try {
      const value = JSON.parse(output.slice(index)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        objects.push(value as Record<string, unknown>);
      }
    } catch {
      // Continue scanning output that contains banners before the JSON payload.
    }
  }
  return objects;
}

function findCronId(output: string, name: string): string {
  for (const value of decodedObjects(output)) {
    if (value.name === name && typeof value.id === "string") return value.id.trim();
  }
  return "";
}

function nativeCronRunAccepted(output: string): boolean {
  return decodedObjects(output).some(
    (value) =>
      value.ok === true &&
      (value.ran === true ||
        (value.enqueued === true && typeof value.runId === "string" && value.runId.length > 0)),
  );
}
