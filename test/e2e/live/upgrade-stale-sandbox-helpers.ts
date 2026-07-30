// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAvailableDashboardPort } from "../../../src/lib/onboard/dashboard-port.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { assertExitZero, resultText } from "../fixtures/clients/index.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  readJsonFileOrFallback,
  restoreFile,
  snapshotFile,
  writeJsonFile,
} from "../fixtures/file-state.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";
import { createOldBaseBuildContext } from "./rebuild-openclaw-old-base-context.ts";

export { REPO_ROOT };

const TEST_SANDBOX_PREFIX = "e2e-upgrade-stale";
export const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
export const SIBLING_SANDBOX_NAME = `${SANDBOX_NAME}-peer`;
export const SANDBOX_NAMES = [SANDBOX_NAME, SIBLING_SANDBOX_NAME] as const;
validateSandboxName(SANDBOX_NAME);
validateSandboxName(SIBLING_SANDBOX_NAME);
assertSafeSandboxName();
export const OLD_OPENCLAW_VERSION = "2026.3.11";
export const OLD_BASE_TAG = `nemoclaw-old-base:${SANDBOX_NAME.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

function assertSafeSandboxName(): void {
  for (const sandboxName of SANDBOX_NAMES) {
    if (!sandboxName.startsWith(TEST_SANDBOX_PREFIX)) {
      throw new Error(
        `upgrade-stale-sandbox live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${sandboxName}`,
      );
    }
  }
}

export function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_REBUILD_VERBOSE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

async function bestEffortPreclean(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup must not mask the primary assertion failure.
  }
}

export function allocateSiblingDashboardPort(forwardListOutput: string | null): number {
  const registry = readJsonFileOrFallback<{
    sandboxes?: Record<string, Record<string, unknown>>;
  }>(REGISTRY_FILE, {});
  const primaryDashboardPort = registry.sandboxes?.[SANDBOX_NAME]?.dashboardPort;
  expect(
    typeof primaryDashboardPort === "number" &&
      Number.isInteger(primaryDashboardPort) &&
      primaryDashboardPort > 0 &&
      primaryDashboardPort <= 65535,
    "initial onboard must persist the dashboard port used by authoritative rebuild",
  ).toBe(true);
  const occupied = new Map([[String(primaryDashboardPort), SANDBOX_NAME]]);
  return findAvailableDashboardPort(
    SIBLING_SANDBOX_NAME,
    primaryDashboardPort === 18790 ? 18791 : 18790,
    forwardListOutput,
    undefined,
    occupied,
  );
}

export function writeStaleRegistryEntries(siblingDashboardPort: number): void {
  const session = readJsonFileOrFallback<Record<string, unknown>>(SESSION_FILE, {});
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
    "nvidia/nvidia/nemotron-3-ultra";
  const registry = readJsonFileOrFallback<{
    sandboxes?: Record<string, Record<string, unknown>>;
    defaultSandbox?: string;
  }>(REGISTRY_FILE, {});
  const currentEntry = registry.sandboxes?.[SANDBOX_NAME] ?? {};
  const dashboardPort = currentEntry.dashboardPort;
  expect(
    typeof dashboardPort === "number" &&
      Number.isInteger(dashboardPort) &&
      dashboardPort > 0 &&
      dashboardPort <= 65535,
    "initial onboard must persist the dashboard port used by authoritative rebuild",
  ).toBe(true);
  const endpointUrl =
    (typeof currentEntry.endpointUrl === "string" && currentEntry.endpointUrl) ||
    (typeof session.endpointUrl === "string" && session.endpointUrl) ||
    null;
  const preferredInferenceApi =
    (typeof currentEntry.preferredInferenceApi === "string" &&
      currentEntry.preferredInferenceApi) ||
    (typeof session.preferredInferenceApi === "string" && session.preferredInferenceApi) ||
    null;
  if (provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint") {
    expect(endpointUrl, "custom stale route must retain its durable endpoint").toBeTruthy();
    expect(
      preferredInferenceApi,
      "custom stale route must retain its durable inference API family",
    ).toBeTruthy();
  }
  registry.sandboxes = registry.sandboxes ?? {};
  for (const [sandboxName, assignedDashboardPort] of [
    [SANDBOX_NAME, dashboardPort],
    [SIBLING_SANDBOX_NAME, siblingDashboardPort],
  ] as const) {
    registry.sandboxes[sandboxName] = {
      name: sandboxName,
      createdAt: new Date().toISOString(),
      model,
      provider,
      endpointUrl,
      preferredInferenceApi,
      gpuEnabled: false,
      policies: [],
      policyTier: null,
      fromDockerfile: null,
      dashboardPort: assignedDashboardPort,
      gatewayName: "nemoclaw",
      openshellVersion: "0.0.71",
      nemoclawVersion: "0.0.71",
      agent: null,
      agentVersion: OLD_OPENCLAW_VERSION,
      // Deliberately omit credentialEnv on both legacy rows. Rebuild must
      // migrate the shared provider identity before deleting either sandbox.
    };
  }
  registry.defaultSandbox = SANDBOX_NAME;
  writeJsonFile(REGISTRY_FILE, registry);
  writeJsonFile(SESSION_FILE, { ...session, sandboxName: SANDBOX_NAME, status: "complete" });
}

export function assertDockerAvailable(
  result: ShellProbeResult,
  skip: (note?: string) => never,
): void {
  result.exitCode === 0 || process.env.GITHUB_ACTIONS === "true"
    ? undefined
    : skip(`Docker is required for stale sandbox upgrade E2E: ${resultText(result)}`);
  result.exitCode === 0 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    (() => {
      throw new Error(`Docker is required for stale sandbox upgrade E2E: ${resultText(result)}`);
    })();
}

export function registerStateRestore(cleanup: Pick<CleanupRegistry, "trackDisposable">): void {
  const registrySnapshot = snapshotFile(REGISTRY_FILE);
  const sessionSnapshot = snapshotFile(SESSION_FILE);
  cleanup.trackDisposable(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
    restoreFile(REGISTRY_FILE, registrySnapshot);
    restoreFile(SESSION_FILE, sessionSnapshot);
  });
}

export async function precleanStaleSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  for (const sandboxName of SANDBOX_NAMES) {
    await bestEffortPreclean(() =>
      host.nemoclaw([sandboxName, "destroy", "--yes"], {
        artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffortPreclean(() =>
      sandbox.openshell(["sandbox", "delete", sandboxName], {
        artifactName: `cleanup-openshell-delete-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
  }
}

export async function cleanupOldImage(host: HostCliClient): Promise<void> {
  const result = await host.command("docker", ["image", "rm", "-f", OLD_BASE_TAG], {
    artifactName: "cleanup-docker-image-upgrade-stale",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  if (result.exitCode === 0 || /No such image|image[^\n]*not found/i.test(resultText(result)))
    return;
  assertExitZero(result, `cleanup Docker image ${OLD_BASE_TAG}`);
}

export async function installCurrentNemoclaw(
  host: HostCliClient,
  hosted: { apiKey: string; env: NodeJS.ProcessEnv },
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName:
        attempt === 1
          ? "phase-1-install-current-nemoclaw"
          : `phase-1-install-current-nemoclaw-attempt-${attempt}`,
      cwd: REPO_ROOT,
      env: commandEnv(hosted.env),
      redactionValues: [hosted.apiKey],
      timeoutMs: 20 * 60_000,
    });
    const retry =
      install.exitCode !== 0 &&
      isTransientProviderValidationFailure(install) &&
      attempt < INSTALL_ATTEMPTS;
    install.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    retry && (await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt)));
    !retry && install.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!install) throw new Error("install command did not run");
  return install;
}

export function assertDeleteInstalledSandboxAllowed(result: ShellProbeResult): void {
  result.exitCode === 0 || expect(result.exitCode, resultText(result)).toBe(1);
  result.exitCode === 0 ||
    expect(resultText(result)).toMatch(/not found|does not exist|no sandbox/i);
}

export async function buildOldOpenClawBase(host: HostCliClient): Promise<ShellProbeResult> {
  const oldBaseBuildContext = createOldBaseBuildContext();
  try {
    return await host.command(
      "docker",
      [
        "build",
        "--build-arg",
        `OPENCLAW_VERSION=${OLD_OPENCLAW_VERSION}`,
        "--build-arg",
        "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
        "-f",
        path.join(REPO_ROOT, "Dockerfile.base"),
        "-t",
        OLD_BASE_TAG,
        oldBaseBuildContext,
      ],
      {
        artifactName: "phase-2-build-old-openclaw-base",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 20 * 60_000,
      },
    );
  } finally {
    fs.rmSync(oldBaseBuildContext, { recursive: true, force: true });
  }
}

export function createFixtureDockerfile(cleanup: Pick<CleanupRegistry, "trackDisposable">): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-openclaw-"));
  cleanup.trackDisposable("remove stale sandbox fixture Dockerfile", () =>
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
  return fixtureDockerfile;
}

export async function waitSandboxReady(
  host: HostCliClient,
  sandboxName: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command(
    "bash",
    [
      "-lc",
      `for _i in $(seq 1 30); do openshell sandbox list 2>/dev/null | grep -q '${sandboxName}.*Ready' && exit 0; sleep 5; done; openshell sandbox list >&2; exit 1`,
    ],
    { artifactName, env: commandEnv(), timeoutMs: 180_000 },
  );
}

export function registeredStaleSandboxJson(): string {
  return fs.readFileSync(REGISTRY_FILE, "utf8");
}
