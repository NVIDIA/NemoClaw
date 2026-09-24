// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { loadSession } from "../../../src/lib/state/onboard-session.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupAcquiredResource,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-deferred";
validateSandboxName(SANDBOX_NAME);
const PHASES = [
  "verify the fresh runner",
  "install without inference credentials",
  "complete the deferred installation",
] as const;

test(
  "deferred-onboarding: the installed agent onboards after credentials arrive",
  { timeout: testTimeout(45 * 60_000), meta: { e2ePhases: PHASES } },
  async ({ artifacts, cleanup, host, lifecycle, runtimeProvider, sandbox, secrets, progress }) => {
    const credential = secrets.required("NVIDIA_API_KEY");
    const agent = process.env.NEMOCLAW_AGENT as "hermes" | "langchain-deepagents-code";
    expect(["hermes", "langchain-deepagents-code"]).toContain(agent);
    const cli = agent === "hermes" ? "nemohermes" : "nemo-deepagents";
    const redactionValues = secrets.redactionValues();
    const env: NodeJS.ProcessEnv = {
      ...buildAvailabilityProbeEnv(),
      NEMOCLAW_AGENT: agent,
      NEMOCLAW_PROVIDER: "build",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    };
    const commandOptions = { env, redactionValues, timeoutMs: 60_000 };
    await artifacts.target.declare({
      id: "deferred-onboarding",
      boundary:
        "public installer without credentials, followed by the installed agent onboarding command",
      agent,
      sandboxName: SANDBOX_NAME,
    });

    progress.phase("verify the fresh runner");
    await runtimeProvider.requireAvailable({
      artifactName: "deferred-runtime-prerequisite",
      scenarioLabel: "deferred onboarding",
    });
    expect(getSandbox(SANDBOX_NAME)).toBeNull();
    const before = await sandbox.openshell(["gateway", "list", "-o", "json"], {
      ...commandOptions,
      artifactName: "deferred-gateways-before",
    });
    expect(before.exitCode, resultText(before)).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual([]);

    lifecycle.trackInstallerGatewayUserService();
    cleanup.trackDisposable("remove deferred onboarding gateway", () =>
      cleanupWhenOpenShellAvailable(host, commandOptions, () =>
        host.cleanupGatewayRegistration("nemoclaw", commandOptions),
      ),
    );
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupWhenOpenShellAvailable(host, commandOptions, () =>
        sandbox.cleanupSandbox(SANDBOX_NAME, commandOptions),
      ),
    );
    cleanup.trackDisposable(`destroy deferred sandbox ${SANDBOX_NAME}`, () =>
      cleanupAcquiredResource(getSandbox(SANDBOX_NAME) !== null, () =>
        host.cleanupSandbox(SANDBOX_NAME, { ...commandOptions, timeoutMs: 120_000 }),
      ),
    );

    progress.phase("install without inference credentials");
    const installed = await host.command(
      "env",
      [
        "-u",
        "NVIDIA_INFERENCE_API_KEY",
        "-u",
        "NVIDIA_API_KEY",
        "-u",
        "NEMOCLAW_PROVIDER_KEY",
        "bash",
        "install.sh",
        "--non-interactive",
        "--defer-onboarding",
      ],
      {
        ...commandOptions,
        artifactName: "deferred-public-install",
        cwd: REPO_ROOT,
        timeoutMs: execTimeout(30 * 60_000),
      },
    );
    expect(installed.exitCode, resultText(installed)).toBe(0);
    expect(getSandbox(SANDBOX_NAME)).toBeNull();
    expect(loadSession()?.status).not.toBe("complete");
    const deferred = await sandbox.openshell(["gateway", "list", "-o", "json"], {
      ...commandOptions,
      artifactName: "deferred-gateways-after-install",
    });
    expect(deferred.exitCode, resultText(deferred)).toBe(0);
    expect(JSON.parse(deferred.stdout)).toEqual([]);

    progress.phase("complete the deferred installation");
    const onboardEnv = { ...env, NVIDIA_INFERENCE_API_KEY: credential };
    const onboarded = await host.command(cli, ["onboard", "--non-interactive", "--yes"], {
      ...commandOptions,
      env: onboardEnv,
      artifactName: "deferred-public-onboard",
      timeoutMs: execTimeout(30 * 60_000),
    });
    expect(onboarded.exitCode, resultText(onboarded)).toBe(0);
    expect(getSandbox(SANDBOX_NAME)?.agent).toBe(agent);
    expect(loadSession()).toMatchObject({ status: "complete", sandboxName: SANDBOX_NAME });
    assertStockManagedImageReceipt({
      environment: onboardEnv,
      expectedAgent: agent,
      sandboxName: SANDBOX_NAME,
    });
  },
);
