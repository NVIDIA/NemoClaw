// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  readJsonFileOrFallback,
  restoreFile,
  snapshotFile,
  writeJsonFile,
} from "../fixtures/file-state.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BLUEPRINT_RELPATH = path.join("nemoclaw-blueprint", "blueprint.yaml");
const BLUEPRINT = path.join(REPO_ROOT, BLUEPRINT_RELPATH);
const BASE_CONTEXT_SCRIPT_RELPATH = path.join("scripts", "lib", "sandbox-rlimits.sh");
const MCPORTER_RUNTIME_RELPATHS = [
  path.join("agents", "openclaw", "mcporter-runtime", "package.json"),
  path.join("agents", "openclaw", "mcporter-runtime", "package-lock.json"),
];
const TEST_SANDBOX_PREFIX = "e2e-upgrade-stale";
export const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
validateSandboxName(SANDBOX_NAME);
assertSafeSandboxName();
export const OLD_OPENCLAW_VERSION = "2026.3.11";
export const OLD_BASE_TAG = `nemoclaw-old-base:${SANDBOX_NAME.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

function assertSafeSandboxName(): void {
  if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
    throw new Error(
      `upgrade-stale-sandbox live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
    );
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

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup must not mask the primary assertion failure.
  }
}

function createOldBaseBuildContext(): string {
  const buildContext = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-upgrade-stale-base-"));
  fs.mkdirSync(path.join(buildContext, path.dirname(BLUEPRINT_RELPATH)), { recursive: true });
  fs.mkdirSync(path.join(buildContext, path.dirname(BASE_CONTEXT_SCRIPT_RELPATH)), {
    recursive: true,
  });
  const original = fs.readFileSync(BLUEPRINT, "utf8");
  const minOpenClawVersion = /^(\s*min_openclaw_version:\s*).*/m;
  expect(
    minOpenClawVersion.test(original),
    "blueprint min_openclaw_version line was not found",
  ).toBe(true);
  fs.writeFileSync(
    path.join(buildContext, BLUEPRINT_RELPATH),
    original.replace(minOpenClawVersion, `$1"${OLD_OPENCLAW_VERSION}"`),
    "utf8",
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, BASE_CONTEXT_SCRIPT_RELPATH),
    path.join(buildContext, BASE_CONTEXT_SCRIPT_RELPATH),
  );
  for (const relativePath of MCPORTER_RUNTIME_RELPATHS) {
    const target = path.join(buildContext, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), target);
  }
  return buildContext;
}

export function writeStaleRegistryEntry(): void {
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
  const dashboardPort = registry.sandboxes?.[SANDBOX_NAME]?.dashboardPort;
  expect(
    typeof dashboardPort === "number" &&
      Number.isInteger(dashboardPort) &&
      dashboardPort > 0 &&
      dashboardPort <= 65535,
    "initial onboard must persist the dashboard port used by authoritative rebuild",
  ).toBe(true);
  registry.sandboxes = registry.sandboxes ?? {};
  registry.sandboxes[SANDBOX_NAME] = {
    name: SANDBOX_NAME,
    createdAt: new Date().toISOString(),
    model,
    provider,
    gpuEnabled: false,
    policies: [],
    policyTier: null,
    fromDockerfile: null,
    dashboardPort,
    agent: null,
    agentVersion: OLD_OPENCLAW_VERSION,
  };
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

export function registerStateRestore(cleanup: {
  add(name: string, run: () => Promise<void> | void): void;
}): void {
  const registrySnapshot = snapshotFile(REGISTRY_FILE);
  const sessionSnapshot = snapshotFile(SESSION_FILE);
  cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
    restoreFile(REGISTRY_FILE, registrySnapshot);
    restoreFile(SESSION_FILE, sessionSnapshot);
  });
}

export async function cleanupStaleSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
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
}

export async function cleanupOldImage(host: HostCliClient): Promise<void> {
  await bestEffort(() =>
    host.command("docker", ["image", "rm", "-f", OLD_BASE_TAG], {
      artifactName: "cleanup-docker-image-upgrade-stale",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    }),
  );
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

export function createFixtureDockerfile(cleanup: {
  add(name: string, run: () => Promise<void> | void): void;
}): string {
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
  return fixtureDockerfile;
}

export async function waitSandboxReady(
  host: HostCliClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await host.command(
    "bash",
    [
      "-lc",
      `for _i in $(seq 1 30); do openshell sandbox list 2>/dev/null | grep -q '${SANDBOX_NAME}.*Ready' && exit 0; sleep 5; done; openshell sandbox list >&2; exit 1`,
    ],
    { artifactName, env: commandEnv(), timeoutMs: 180_000 },
  );
}

export function registeredStaleSandboxJson(): string {
  return fs.readFileSync(REGISTRY_FILE, "utf8");
}
