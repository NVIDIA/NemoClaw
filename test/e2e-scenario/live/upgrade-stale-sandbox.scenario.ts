// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-upgrade-stale-sandbox.sh.
 *
 * Preserves the legacy #1904 contract with real Docker/OpenShell/NemoClaw
 * boundaries: onboard current NemoClaw, create an old OpenClaw sandbox from a
 * real image, register stale sandbox metadata, prove upgrade-sandboxes detects
 * the stale sandbox, rebuild it, and prove the stale version is gone.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-upgrade-stale";
validateSandboxName(SANDBOX_NAME);
const OLD_OPENCLAW_VERSION = "2026.3.11";
const OLD_BASE_TAG = "nemoclaw-old-base:e2e-upgrade-stale";
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const LIVE_TIMEOUT_MS = 45 * 60_000;
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

function commandEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_REBUILD_VERBOSE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  if (apiKey) {
    env.NVIDIA_INFERENCE_API_KEY = apiKey;
    env.NVIDIA_API_KEY = apiKey;
  }
  return env;
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup must not mask the primary assertion failure.
  }
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeStaleRegistryEntry(): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  const session = readJsonFile(SESSION_FILE);
  const envProvider =
    process.env.NEMOCLAW_PROVIDER === "custom"
      ? "compatible-endpoint"
      : process.env.NEMOCLAW_PROVIDER;
  const provider =
    typeof session.provider === "string" && session.provider
      ? session.provider
      : envProvider || "compatible-endpoint";
  const model =
    (typeof session.model === "string" && session.model) ||
    process.env.NEMOCLAW_MODEL ||
    process.env.NEMOCLAW_COMPAT_MODEL ||
    "nvidia/nvidia/nemotron-3-super-v3";

  fs.writeFileSync(
    REGISTRY_FILE,
    `${JSON.stringify(
      {
        sandboxes: {
          [SANDBOX_NAME]: {
            name: SANDBOX_NAME,
            createdAt: new Date().toISOString(),
            model,
            provider,
            gpuEnabled: false,
            policies: [],
            policyTier: null,
            agent: null,
            agentVersion: OLD_OPENCLAW_VERSION,
          },
        },
        defaultSandbox: SANDBOX_NAME,
      },
      null,
      2,
    )}\n`,
  );

  const updatedSession = {
    ...session,
    sandboxName: SANDBOX_NAME,
    status: "complete",
  };
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(updatedSession, null, 2)}\n`);
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "upgrade-sandboxes detects and rebuilds stale OpenClaw sandboxes (#1904)",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");

    await artifacts.writeJson("scenario.json", {
      id: "upgrade-stale-sandbox",
      runner: "vitest",
      legacySource: "test/e2e/test-upgrade-stale-sandbox.sh",
      boundary: "install.sh + Docker old base image + OpenShell sandbox create + NemoClaw rebuild",
      sandboxName: SANDBOX_NAME,
      oldOpenClawVersion: OLD_OPENCLAW_VERSION,
      contracts: [
        "current NemoClaw install/onboard succeeds before stale fixture creation",
        "an old OpenClaw base image can be created with the legacy version",
        "a sandbox registered with old agentVersion is reported stale by upgrade-sandboxes --check",
        "nemoclaw <sandbox> rebuild --yes upgrades the sandbox away from the old OpenClaw version",
        "upgrade-sandboxes --check reports up-to-date after rebuild",
      ],
    });

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for stale sandbox upgrade E2E: ${resultText(dockerInfo)}`,
        );
      }
      skip(`Docker is required for stale sandbox upgrade E2E: ${resultText(dockerInfo)}`);
    }

    cleanup.add(`destroy stale sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-upgrade-stale",
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete-upgrade-stale",
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
    });
    cleanup.add("remove stale OpenClaw test image", async () => {
      await bestEffort(() =>
        host.command("docker", ["image", "rm", "-f", OLD_BASE_TAG], {
          artifactName: "cleanup-docker-image-upgrade-stale",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() =>
      host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-upgrade-stale",
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-upgrade-stale",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );

    let install: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
      install = await host.command("bash", ["install.sh", "--non-interactive"], {
        artifactName:
          attempt === 1
            ? "phase-1-install-current-nemoclaw"
            : `phase-1-install-current-nemoclaw-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: commandEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: 20 * 60_000,
      });
      if (install.exitCode === 0) break;
      if (isTransientProviderValidationFailure(install) && attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
    expect(install, "install command must run").toBeDefined();
    expect(install?.exitCode, resultText(install as ShellProbeResult)).toBe(0);

    const deleteInstalledSandbox = await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "phase-2-delete-installed-sandbox",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(
      deleteInstalledSandbox.exitCode === 0 || deleteInstalledSandbox.exitCode === 1,
      resultText(deleteInstalledSandbox),
    ).toBe(true);

    const blueprint = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
    const originalBlueprint = fs.readFileSync(blueprint, "utf8");
    cleanup.add("restore blueprint after old OpenClaw build", () => {
      fs.writeFileSync(blueprint, originalBlueprint);
    });
    fs.writeFileSync(
      blueprint,
      originalBlueprint.replace(
        /min_openclaw_version:.*/u,
        `min_openclaw_version: "${OLD_OPENCLAW_VERSION}"`,
      ),
    );
    try {
      const buildOldBase = await host.command(
        "docker",
        [
          "build",
          "--build-arg",
          `OPENCLAW_VERSION=${OLD_OPENCLAW_VERSION}`,
          "-f",
          path.join(REPO_ROOT, "Dockerfile.base"),
          "-t",
          OLD_BASE_TAG,
          REPO_ROOT,
        ],
        {
          artifactName: "phase-2-build-old-openclaw-base",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 20 * 60_000,
        },
      );
      expect(buildOldBase.exitCode, resultText(buildOldBase)).toBe(0);
    } finally {
      fs.writeFileSync(blueprint, originalBlueprint);
    }

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-openclaw-"));
    cleanup.add("remove stale sandbox fixture Dockerfile", () =>
      fs.rmSync(fixtureDir, { recursive: true, force: true }),
    );
    const fixtureDockerfile = path.join(fixtureDir, "Dockerfile");
    fs.writeFileSync(
      fixtureDockerfile,
      [
        `FROM ${OLD_BASE_TAG}`,
        "USER sandbox",
        "WORKDIR /sandbox",
        "RUN mkdir -p /sandbox/.openclaw/workspace /sandbox/.openclaw && echo '{}' > /sandbox/.openclaw/openclaw.json",
        'CMD ["/bin/bash"]',
        "",
      ].join("\n"),
    );

    const createOldSandbox = await sandbox.openshell(
      [
        "sandbox",
        "create",
        "--name",
        SANDBOX_NAME,
        "--from",
        fixtureDockerfile,
        "--gateway",
        "nemoclaw",
        "--no-tty",
        "--",
        "true",
      ],
      {
        artifactName: "phase-3-create-old-openclaw-sandbox",
        env: commandEnv(),
        timeoutMs: 15 * 60_000,
      },
    );
    expect(createOldSandbox.exitCode, resultText(createOldSandbox)).toBe(0);

    const waitReady = await host.command(
      "bash",
      [
        "-lc",
        `for _i in $(seq 1 30); do openshell sandbox list 2>/dev/null | grep -q '${SANDBOX_NAME}.*Ready' && exit 0; sleep 5; done; openshell sandbox list >&2; exit 1`,
      ],
      { artifactName: "phase-3-wait-old-sandbox-ready", env: commandEnv(), timeoutMs: 180_000 },
    );
    expect(waitReady.exitCode, resultText(waitReady)).toBe(0);

    const oldVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "phase-3-old-openclaw-version",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(oldVersion.exitCode, resultText(oldVersion)).toBe(0);
    expect(resultText(oldVersion)).toContain(OLD_OPENCLAW_VERSION);

    writeStaleRegistryEntry();
    await artifacts.writeText(
      "registered-stale-sandbox.json",
      fs.readFileSync(REGISTRY_FILE, "utf8"),
    );

    const staleCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
      artifactName: "phase-5-upgrade-sandboxes-check-stale",
      env: commandEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    expect(resultText(staleCheck)).toMatch(/stale|need upgrading/i);
    expect(resultText(staleCheck)).not.toMatch(/up to date/i);

    const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "phase-6-rebuild-stale-sandbox",
      env: commandEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 25 * 60_000,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);

    const waitRebuiltReady = await host.command(
      "bash",
      [
        "-lc",
        `for _i in $(seq 1 30); do openshell sandbox list 2>/dev/null | grep -q '${SANDBOX_NAME}.*Ready' && exit 0; sleep 5; done; openshell sandbox list >&2; exit 1`,
      ],
      { artifactName: "phase-6-wait-rebuilt-sandbox-ready", env: commandEnv(), timeoutMs: 180_000 },
    );
    expect(waitRebuiltReady.exitCode, resultText(waitRebuiltReady)).toBe(0);

    const newVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "phase-6-new-openclaw-version",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(newVersion.exitCode, resultText(newVersion)).toBe(0);
    expect(resultText(newVersion)).not.toContain(OLD_OPENCLAW_VERSION);

    const cleanCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
      artifactName: "phase-7-upgrade-sandboxes-check-clean",
      env: commandEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    expect(resultText(cleanCheck)).toMatch(/up to date/i);
  },
);
