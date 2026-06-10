// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

// Focused Vitest replacement coverage for the first contract from
// test/e2e/test-onboard-negative-paths.sh. Keep this free-standing: the
// behavior under test is the real CLI/non-interactive onboard boundary, not the
// typed registry/state-validation scenario model.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const SESSION_FILE = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "onboard-session.json");
const INVALID_NVIDIA_API_KEY = "not-a-nvidia-key";
const STACK_TRACE_PATTERNS = [/(^|\s)(TypeError|ReferenceError|SyntaxError):/m, /^\s+at /m];

process.env.NEMOCLAW_CLI_BIN ??= path.join(REPO_ROOT, "bin", "nemoclaw.js");

const liveTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function hasStackTrace(text: string): boolean {
  return STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

function onboardEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup is best-effort because this negative path can fail before
    // OpenShell exists on PATH or before any sandbox/gateway state is created.
  }
}

async function cleanupInvalidKeyState(host: HostCliClient, sandboxName: string): Promise<void> {
  await ignoreCleanupError(() =>
    host.nemoclaw([sandboxName, "destroy", "--yes"], {
      artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
      env: onboardEnv({}),
      timeoutMs: 60_000,
    }),
  );
  await ignoreCleanupError(() =>
    host.command("openshell", ["sandbox", "delete", sandboxName], {
      artifactName: `cleanup-openshell-sandbox-delete-${sandboxName}`,
      env: onboardEnv({}),
      timeoutMs: 60_000,
    }),
  );
  await ignoreCleanupError(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy-nemoclaw",
      env: onboardEnv({}),
      timeoutMs: 60_000,
    }),
  );
  fs.rmSync(SESSION_FILE, { force: true });
}

liveTest(
  "onboard invalid NVIDIA key exits cleanly without a stack trace",
  async ({ artifacts, cleanup, host, skip }) => {
    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-onboard-invalid-key",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required to reach the live onboard invalid-key validation path: ${resultText(docker)}`,
        );
      }
      skip("Docker is required to reach the live onboard invalid-key validation path");
    }

    expect(
      fs.existsSync(CLI_DIST_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    const sandboxName = `e2e-invalid-key-${process.pid}`;
    cleanup.add(`remove invalid-key onboard residue for ${sandboxName}`, async () => {
      await cleanupInvalidKeyState(host, sandboxName);
    });
    await cleanupInvalidKeyState(host, sandboxName);

    await artifacts.writeJson("scenario.json", {
      id: "onboard-invalid-nvidia-key",
      runner: "vitest",
      boundary: "direct-cli-onboard",
      legacySource: "test/e2e/test-onboard-negative-paths.sh",
      contract: [
        "invalid NVIDIA key exits non-zero",
        "invalid NVIDIA key message is explicit",
        "invalid NVIDIA key path does not print a JavaScript stack trace",
      ],
    });

    const result = await host.nemoclaw(
      ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      {
        artifactName: "onboard-invalid-nvidia-key",
        env: onboardEnv({
          NEMOCLAW_SANDBOX_NAME: sandboxName,
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_PROVIDER: "cloud",
          NEMOCLAW_POLICY_MODE: "skip",
          NVIDIA_API_KEY: INVALID_NVIDIA_API_KEY,
        }),
        redactionValues: [INVALID_NVIDIA_API_KEY],
        timeoutMs: 5 * 60_000,
      },
    );
    const text = resultText(result);

    expect(result.exitCode, text).not.toBe(0);
    expect(text).toContain("Invalid NVIDIA API key");
    expect(text).toContain("Must start with nvapi-");
    expect(hasStackTrace(text), text).toBe(false);

    await artifacts.writeJson("scenario-result.json", {
      id: "onboard-invalid-nvidia-key",
      exitCode: result.exitCode,
      assertions: {
        nonZeroExit: result.exitCode !== 0,
        explicitMessage:
          text.includes("Invalid NVIDIA API key") && text.includes("Must start with nvapi-"),
        noStackTrace: !hasStackTrace(text),
      },
    });
  },
);
