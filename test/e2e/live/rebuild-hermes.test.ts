// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  readJsonFileOr,
  restoreFile,
  snapshotFile,
  writeJsonFile,
} from "../fixtures/file-state.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { listCredentialLeakPaths } from "../fixtures/phases/state-validation.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { buildRebuildHermesChildEnv } from "./rebuild-hermes-env.ts";

// The migrated scope is the legacy non-interactive shell regression: install.sh,
// Docker base-image builds, OpenShell provider/sandbox commands, direct Hermes
// sandbox exec, curated local NemoClaw registry/session state, and
// `nemoclaw <name> rebuild --yes`. Literal interactive issue #3025 reproduction
// paths (`./bin/nemoclaw.js onboard --agent hermes`, `hermes rebuild`, modal
// prompt, and `Y` confirmation) are outside this shell-lane migration.
// Vitest.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_MANIFEST = path.join(REPO_ROOT, "agents", "hermes", "manifest.yaml");
const OLD_HERMES_VERSION = "v2026.5.16";
const OLD_HERMES_REGISTRY_VERSION = OLD_HERMES_VERSION.slice(1);
const OLD_HERMES_SEMVER = "0.14.0";
const OLD_HERMES_TARBALL_SHA256 =
  "c0a554050a50ee9a62f3fa5cd288a167ba5640c42d647d100cdea084b7294143";
const OLD_HERMES_NPM_INTEGRITY =
  "sha512-kkHSw8iprp0JWAOf3ZZF0OHzRBj3E/BbG/QV0O4lwonxuY7AWhSepOhzSMlWo21VbQ/fTLwFkr/q3cIjDZDLBA==";
const STALE_BASE_REBUILD = process.env.NEMOCLAW_HERMES_STALE_BASE_REBUILD_E2E === "1";
const TEST_SANDBOX_PREFIX = STALE_BASE_REBUILD ? "e2e-rebuild-hermes-base" : "e2e-rebuild-hermes";
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
validateSandboxName(SANDBOX_NAME);
SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX) ||
  fail(
    `rebuild-hermes live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
  );

const MARKER_FILE = "/sandbox/.hermes/memories/rebuild-marker.txt";
const MARKER_CONTENT = `REBUILD_HM_E2E_${Date.now()}`;
const DISCORD_PLACEHOLDER = "openshell:resolve:env:DISCORD_BOT_TOKEN";
const DISCORD_FAKE_TOKEN = "test-fake-discord-token-rebuild-e2e";
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const BACKUP_ROOT = path.join(os.homedir(), ".nemoclaw", "rebuild-backups");
const HOSTED_ENDPOINT_URL =
  process.env.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1";
const HOSTED_MODEL =
  process.env.NEMOCLAW_MODEL ??
  process.env.NEMOCLAW_COMPAT_MODEL ??
  "nvidia/nvidia/nemotron-3-ultra";
const OLD_BASE_TAG = `nemoclaw-hermes-old-base:${SANDBOX_NAME.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
const CURRENT_BASE_TAG = "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest";

const INSTALL_TIMEOUT_MS = 60 * 60_000;
const DOCKER_BUILD_TIMEOUT_MS = 35 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;
const SANDBOX_CREATE_TIMEOUT_MS = 10 * 60_000;
const REBUILD_TIMEOUT_MS = 45 * 60_000;
const LIVE_TIMEOUT_MS = 100 * 60_000;

interface RegistryData {
  sandboxes?: Record<string, Record<string, unknown>>;
  defaultSandbox?: string;
}

interface SessionArtifactSummary {
  sandboxName: string;
  agent: "hermes";
  status: "complete";
  provider: "compatible-endpoint";
  model: string;
  messagingPlan: {
    schemaVersion: number;
    channelIds: string[];
    credentialBindings: Array<{
      channelId: string;
      credentialId: string;
      providerEnvKey: string;
      placeholder: string;
      credentialAvailable: boolean;
    }>;
  };
}

function testEnv(apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return buildRebuildHermesChildEnv(process.env, {
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_COMPAT_MODEL: HOSTED_MODEL,
    NEMOCLAW_ENDPOINT_URL: HOSTED_ENDPOINT_URL,
    NEMOCLAW_MODEL: HOSTED_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...(apiKey
      ? {
          COMPATIBLE_API_KEY: apiKey,
          NVIDIA_INFERENCE_API_KEY: apiKey,
        }
      : {}),
    ...extra,
  });
}

function fail(message: string): never {
  throw new Error(message);
}

function expectedHermesVersion(): string {
  const manifest = fs.readFileSync(HERMES_MANIFEST, "utf8");
  const match = manifest.match(/^expected_version:\s*"?([^"\n]+)"?/m);
  expect(match?.[1], `Could not parse expected Hermes version from ${HERMES_MANIFEST}`).toEqual(
    expect.any(String),
  );
  return match![1].trim();
}

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label} failed:\n${resultText(result)}`).toBe(0);
}

function expectEqual(actual: string | undefined, expected: string, message: string): void {
  switch (actual === expected) {
    case true:
      return;
    default:
      throw new Error(message);
  }
}

async function cleanupHermesResources(
  host: HostCliClient,
  apiKey: string | undefined,
  artifactName: string,
): Promise<void> {
  await host.command(
    "bash",
    [
      "-lc",
      [
        "set +e",
        'if command -v nemoclaw >/dev/null 2>&1; then nemoclaw "$SANDBOX_NAME" destroy --yes --cleanup-gateway >/dev/null 2>&1 || true; fi',
        'if command -v openshell >/dev/null 2>&1; then openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true; fi',
        "if command -v openshell >/dev/null 2>&1; then openshell forward stop 8642 >/dev/null 2>&1 || true; fi",
        'if command -v openshell >/dev/null 2>&1; then openshell provider delete "$DISCORD_PROVIDER" >/dev/null 2>&1 || true; fi',
        'docker rmi "$OLD_BASE_TAG" >/dev/null 2>&1 || true',
        "exit 0",
      ].join("\n"),
    ],
    {
      artifactName,
      env: testEnv(apiKey, {
        DISCORD_PROVIDER: `${SANDBOX_NAME}-discord-bridge`,
        OLD_BASE_TAG,
      }),
      redactionValues: [apiKey ?? "", DISCORD_FAKE_TOKEN],
      timeoutMs: 3 * 60_000,
    },
  );
}

function oldHermesDockerfile(): string {
  return [
    `FROM ${OLD_BASE_TAG}`,
    "USER sandbox",
    "WORKDIR /sandbox",
    "RUN mkdir -p /sandbox/.hermes/memories \\",
    "             /sandbox/.hermes/sessions \\",
    "             /sandbox/.hermes/workspace \\",
    "    && printf '%s\\n' \\",
    "      '_config_version: 12' \\",
    "      'platforms:' \\",
    "      '  discord:' \\",
    "      '    enabled: true' \\",
    `      '    token: "${DISCORD_PLACEHOLDER}"' \\`,
    "      '  api_server:' \\",
    "      '    enabled: true' \\",
    "      '    extra:' \\",
    "      '      port: 18642' \\",
    "      '      host: 127.0.0.1' \\",
    "      > /sandbox/.hermes/config.yaml \\",
    "    && printf '%s\\n' \\",
    "      'API_SERVER_PORT=18642' \\",
    "      'API_SERVER_HOST=127.0.0.1' \\",
    `      'DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}' \\`,
    "      > /sandbox/.hermes/.env",
    'CMD ["/bin/bash"]',
    "",
  ].join("\n");
}

async function waitForSandboxReady(host: HostCliClient, apiKey: string): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const list = await host.command("openshell", ["sandbox", "list"], {
      artifactName: `phase-3-sandbox-list-${attempt}`,
      env: testEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    });
    switch (new RegExp(`${SANDBOX_NAME}.*Ready`).test(resultText(list))) {
      case true:
        return;
      default:
        await sleep(5_000);
    }
  }
  throw new Error(`sandbox ${SANDBOX_NAME} did not become Ready`);
}

function seedRegistryAndSession(dashboardPort: number): SessionArtifactSummary {
  const registry = readJsonFileOr<RegistryData>(REGISTRY_FILE, {});
  registry.sandboxes = registry.sandboxes ?? {};

  const credentialHash = createHash("sha256").update(DISCORD_FAKE_TOKEN).digest("hex");
  const messagingPlan = {
    schemaVersion: 1,
    sandboxName: SANDBOX_NAME,
    agent: "hermes",
    workflow: "onboard",
    channels: [
      {
        channelId: "discord",
        displayName: "discord",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: `${SANDBOX_NAME}-discord-bridge`,
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: DISCORD_PLACEHOLDER,
        credentialAvailable: true,
        credentialHash,
      },
    ],
    networkPolicy: { presets: ["discord"], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };

  registry.sandboxes[SANDBOX_NAME] = {
    name: SANDBOX_NAME,
    createdAt: new Date().toISOString(),
    model: HOSTED_MODEL,
    provider: "compatible-endpoint",
    endpointUrl: HOSTED_ENDPOINT_URL,
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    gpuEnabled: false,
    policies: [],
    policyTier: null,
    agent: "hermes",
    agentVersion: OLD_HERMES_REGISTRY_VERSION,
    dashboardPort,
    // This curated old-version fixture is still a NemoClaw-managed image.
    // Preserve that provenance explicitly; an absent value must remain
    // fail-closed because it could represent a custom `--from` image.
    fromDockerfile: null,
    messaging: { schemaVersion: 1, plan: messagingPlan },
  };
  expect(
    Object.prototype.hasOwnProperty.call(
      registry.sandboxes[SANDBOX_NAME],
      "providerCredentialHashes",
    ),
    "legacy providerCredentialHashes must stay out of the curated rebuild registry; credential fingerprints live on messaging plan bindings",
  ).toBe(false);
  registry.defaultSandbox = SANDBOX_NAME;
  writeJsonFile(REGISTRY_FILE, registry);

  const session = {
    sandboxName: SANDBOX_NAME,
    agent: "hermes" as const,
    status: "complete" as const,
    provider: "compatible-endpoint" as const,
    model: HOSTED_MODEL,
    endpointUrl: HOSTED_ENDPOINT_URL,
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    messagingPlan,
  };
  writeJsonFile(SESSION_FILE, session);

  return {
    sandboxName: session.sandboxName,
    agent: session.agent,
    status: session.status,
    provider: session.provider,
    model: session.model,
    messagingPlan: {
      schemaVersion: messagingPlan.schemaVersion,
      channelIds: messagingPlan.channels.map((channel) => channel.channelId),
      credentialBindings: messagingPlan.credentialBindings.map((binding) => ({
        channelId: binding.channelId,
        credentialId: binding.credentialId,
        providerEnvKey: binding.providerEnvKey,
        placeholder: binding.placeholder,
        credentialAvailable: binding.credentialAvailable,
      })),
    },
  };
}

function registryVersion(): unknown {
  return registrySandbox().agentVersion;
}

function registrySandbox(): Record<string, unknown> {
  const sandbox = readJsonFileOr<RegistryData>(REGISTRY_FILE, {}).sandboxes?.[SANDBOX_NAME];
  expect(sandbox, `registry entry missing for ${SANDBOX_NAME}`).toBeDefined();
  return sandbox as Record<string, unknown>;
}

test.skipIf(!shouldRunLiveE2E())(
  STALE_BASE_REBUILD
    ? "rebuild-hermes: stale base cache is refreshed while Hermes state survives rebuild"
    : "rebuild-hermes: old Hermes sandbox rebuild preserves messaging state and upgrades runtime",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const redactionValues = [apiKey, DISCORD_FAKE_TOKEN];
    const expectedVersion = expectedHermesVersion();

    const registrySnapshot = snapshotFile(REGISTRY_FILE);
    const sessionSnapshot = snapshotFile(SESSION_FILE);
    const sandboxBackupRoot = path.join(BACKUP_ROOT, SANDBOX_NAME);
    cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
      restoreFile(REGISTRY_FILE, registrySnapshot);
      restoreFile(SESSION_FILE, sessionSnapshot);
      fs.rmSync(sandboxBackupRoot, { recursive: true, force: true });
    });
    cleanup.add(`destroy Hermes rebuild resources for ${SANDBOX_NAME}`, async () => {
      await cleanupHermesResources(host, apiKey, "cleanup-hermes-rebuild-resources");
    });

    await artifacts.writeJson("contract.json", {
      staleBaseMode: STALE_BASE_REBUILD,
      sandboxName: SANDBOX_NAME,
      oldHermesVersion: OLD_HERMES_VERSION,
      expectedHermesVersion: expectedVersion,
      markerFile: MARKER_FILE,
      preservedBoundaries: [
        "bash install.sh --non-interactive",
        "docker build agents/hermes/Dockerfile.base for old/current Hermes base images",
        "openshell provider create/update and sandbox create/exec/list",
        "curated local ~/.nemoclaw registry and onboard-session rebuild metadata",
        "real nemoclaw <sandbox> rebuild --yes --verbose",
        "Hermes .env/config.yaml messaging placeholder preservation",
        "backup credential leak scan under ~/.nemoclaw/rebuild-backups",
      ],
      outOfScope: [
        "interactive ./bin/nemoclaw.js onboard --agent hermes reproduction path",
        "interactive hermes rebuild modal prompt and Y confirmation",
      ],
    });

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    switch (dockerInfo.exitCode === 0) {
      case false:
        switch (process.env.GITHUB_ACTIONS === "true") {
          case true:
            throw new Error(
              `Docker is required for rebuild-hermes live coverage: ${resultText(dockerInfo)}`,
            );
          default:
            skip("Docker is required for rebuild-hermes live coverage");
        }
    }

    await cleanupHermesResources(host, apiKey, "pre-cleanup-hermes-rebuild-resources");

    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-1-install-hermes",
      cwd: REPO_ROOT,
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    expectExitZero(install, "NemoClaw install.sh");

    const cliProbe = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && command -v openshell && nemoclaw --help >/dev/null"],
      {
        artifactName: "phase-1-cli-probe",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(cliProbe, "NemoClaw/OpenShell installed by install.sh");

    const gatewayProbe = await host.command("openshell", ["gateway", "info", "-g", "nemoclaw"], {
      artifactName: "phase-1-gateway-probe",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: 30_000,
    });
    expectExitZero(gatewayProbe, "NemoClaw install must leave a reusable 'nemoclaw' gateway");

    const phase1DashboardPort = registrySandbox().dashboardPort;
    expect(
      typeof phase1DashboardPort === "number" &&
        Number.isInteger(phase1DashboardPort) &&
        phase1DashboardPort > 0 &&
        phase1DashboardPort <= 65535,
      "initial Hermes onboard must persist the dashboard port used by authoritative rebuild",
    ).toBe(true);

    const deleteCurrentSandbox = await host.command(
      "openshell",
      ["sandbox", "delete", SANDBOX_NAME],
      {
        artifactName: "phase-1-delete-current-sandbox",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    deleteCurrentSandbox.exitCode === 0 ||
      (await artifacts.writeText(
        "phase-1-delete-current-sandbox-note.txt",
        resultText(deleteCurrentSandbox),
      ));
    await host.command("openshell", ["forward", "stop", "8642"], {
      artifactName: "phase-1-stop-hermes-forward",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    });

    const buildOldBase = await host.command(
      "docker",
      [
        "build",
        "--build-arg",
        `HERMES_VERSION=${OLD_HERMES_VERSION}`,
        "--build-arg",
        `HERMES_SEMVER=${OLD_HERMES_SEMVER}`,
        "--build-arg",
        `HERMES_TARBALL_SHA256=${OLD_HERMES_TARBALL_SHA256}`,
        "--build-arg",
        `HERMES_NPM_INTEGRITY=${OLD_HERMES_NPM_INTEGRITY}`,
        "--build-arg",
        "HERMES_UV_EXTRAS=messaging mcp",
        "-f",
        path.join(REPO_ROOT, "agents", "hermes", "Dockerfile.base"),
        "-t",
        OLD_BASE_TAG,
        REPO_ROOT,
      ],
      {
        artifactName: "phase-2-docker-build-old-hermes-base",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(buildOldBase, `docker build old Hermes base ${OLD_HERMES_VERSION}`);

    switch (STALE_BASE_REBUILD) {
      case true: {
        const tagOldAsCurrent = await host.command(
          "docker",
          ["tag", OLD_BASE_TAG, CURRENT_BASE_TAG],
          {
            artifactName: "phase-2-tag-old-base-as-current-cache",
            env: testEnv(apiKey),
            redactionValues,
            timeoutMs: OPENSHELL_TIMEOUT_MS,
          },
        );
        expectExitZero(tagOldAsCurrent, "tag old Hermes base as current cache");
        break;
      }
    }

    const oldDockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-hermes-"));
    const oldDockerfile = path.join(oldDockerfileDir, "Dockerfile");
    fs.writeFileSync(oldDockerfile, oldHermesDockerfile(), "utf8");
    try {
      const provider = await host.command(
        "bash",
        [
          "-lc",
          [
            "set -euo pipefail",
            'openshell provider create --name "$DISCORD_PROVIDER" --type generic --credential DISCORD_BOT_TOKEN ||',
            '  openshell provider update "$DISCORD_PROVIDER" --credential DISCORD_BOT_TOKEN',
          ].join("\n"),
        ],
        {
          artifactName: "phase-3-discord-provider-create-or-update",
          env: testEnv(apiKey, {
            DISCORD_BOT_TOKEN: DISCORD_FAKE_TOKEN,
            DISCORD_PROVIDER: `${SANDBOX_NAME}-discord-bridge`,
          }),
          redactionValues,
          timeoutMs: OPENSHELL_TIMEOUT_MS,
        },
      );
      expectExitZero(provider, "OpenShell Discord provider create/update");

      const createOldSandbox = await host.command(
        "openshell",
        [
          "sandbox",
          "create",
          "--name",
          SANDBOX_NAME,
          "--from",
          oldDockerfile,
          "--gateway",
          "nemoclaw",
          "--provider",
          `${SANDBOX_NAME}-discord-bridge`,
          "--no-tty",
          "--",
          "true",
        ],
        {
          artifactName: "phase-3-create-old-hermes-sandbox",
          env: testEnv(apiKey),
          redactionValues,
          timeoutMs: SANDBOX_CREATE_TIMEOUT_MS,
        },
      );
      expectExitZero(createOldSandbox, "create old Hermes sandbox");
    } finally {
      fs.rmSync(oldDockerfileDir, { recursive: true, force: true });
    }
    await waitForSandboxReady(host, apiKey);

    const writeMarker = await host.command(
      "openshell",
      [
        "sandbox",
        "exec",
        "--name",
        SANDBOX_NAME,
        "--",
        "sh",
        "-c",
        `mkdir -p /sandbox/.hermes/memories && printf '%s' ${shellQuote(MARKER_CONTENT)} > ${shellQuote(MARKER_FILE)}`,
      ],
      {
        artifactName: "phase-4-write-hermes-marker",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(writeMarker, "write Hermes marker");

    const preEnv = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "cat", "/sandbox/.hermes/.env"],
      {
        artifactName: "phase-4-read-pre-rebuild-env",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(preEnv, "read pre-rebuild Hermes .env");
    expect(preEnv.stdout).toContain(`DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}`);

    const preConfig = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "cat", "/sandbox/.hermes/config.yaml"],
      {
        artifactName: "phase-4-read-pre-rebuild-config",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(preConfig, "read pre-rebuild Hermes config.yaml");
    expect(preConfig.stdout).toContain("discord:");

    const sessionSummary = seedRegistryAndSession(phase1DashboardPort as number);
    const seededRegistry = registrySandbox();
    await artifacts.writeJson("phase-4-registry-session-summary.json", {
      registryVersion: seededRegistry.agentVersion,
      dashboardPort: seededRegistry.dashboardPort,
      registryInference: {
        provider: seededRegistry.provider,
        endpointUrl: seededRegistry.endpointUrl,
        credentialEnv: seededRegistry.credentialEnv,
        preferredInferenceApi: seededRegistry.preferredInferenceApi,
      },
      session: sessionSummary,
    });

    switch (STALE_BASE_REBUILD) {
      case false: {
        const buildCurrentBase = await host.command(
          "docker",
          [
            "build",
            "-f",
            path.join(REPO_ROOT, "agents", "hermes", "Dockerfile.base"),
            "-t",
            CURRENT_BASE_TAG,
            REPO_ROOT,
          ],
          {
            artifactName: "phase-5-docker-build-current-hermes-base",
            env: testEnv(apiKey),
            redactionValues,
            timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
          },
        );
        expectExitZero(buildCurrentBase, "docker build current Hermes base image");
        break;
      }
      case true:
        await artifacts.writeText(
          "phase-5-stale-base-note.txt",
          `Left ${CURRENT_BASE_TAG} pointing at ${OLD_HERMES_VERSION}; rebuild must refresh the base cache.\n`,
        );
    }

    const rebuild = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "phase-6-nemoclaw-rebuild-hermes",
        env: testEnv(apiKey, { NEMOCLAW_REBUILD_VERBOSE: "1" }),
        redactionValues,
        timeoutMs: REBUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(rebuild, "nemoclaw rebuild Hermes sandbox");

    const restoredMarker = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "cat", MARKER_FILE],
      {
        artifactName: "phase-7-read-marker-after-rebuild",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(restoredMarker, "read Hermes marker after rebuild");
    expect(restoredMarker.stdout).toBe(MARKER_CONTENT);

    const hermesVersion = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "hermes", "--version"],
      {
        artifactName: "phase-7-hermes-version-after-rebuild",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(hermesVersion, "Hermes version after rebuild");
    expect(resultText(hermesVersion)).not.toContain(OLD_HERMES_REGISTRY_VERSION);
    const hermesVersionText = resultText(hermesVersion);
    const actualHermesVersion = hermesVersionText.match(/v(\d+\.\d+\.\d+)/)?.[1];
    expectEqual(
      actualHermesVersion,
      expectedVersion,
      `Hermes version output did not include expected release ${expectedVersion}: ${hermesVersionText}`,
    );

    const restoredEnv = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "cat", "/sandbox/.hermes/.env"],
      {
        artifactName: "phase-7-read-env-after-rebuild",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(restoredEnv, "read Hermes .env after rebuild");
    expect(restoredEnv.stdout).toContain(`DISCORD_BOT_TOKEN=${DISCORD_PLACEHOLDER}`);

    const restoredConfig = await host.command(
      "openshell",
      ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "cat", "/sandbox/.hermes/config.yaml"],
      {
        artifactName: "phase-7-read-config-after-rebuild",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(restoredConfig, "read Hermes config.yaml after rebuild");
    expect(restoredConfig.stdout).toContain("discord:");

    const updatedRegistryVersion = registryVersion();
    expect(updatedRegistryVersion).toEqual(expect.any(String));
    expect(updatedRegistryVersion).not.toBe(OLD_HERMES_REGISTRY_VERSION);

    const inferencePayload = JSON.stringify({
      model: HOSTED_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const inference = await host.command(
      "openshell",
      [
        "sandbox",
        "exec",
        "--name",
        SANDBOX_NAME,
        "--",
        "sh",
        "-lc",
        `curl -s --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d ${shellQuote(inferencePayload)}`,
      ],
      {
        artifactName: "phase-7-inference-after-rebuild",
        env: testEnv(apiKey),
        redactionValues,
        timeoutMs: 90_000,
      },
    );
    await artifacts.writeJson("phase-7-inference-summary.json", {
      exitCode: inference.exitCode,
      pong: /PONG/i.test(resultText(inference)),
      note: /PONG/i.test(resultText(inference))
        ? "Inference returned PONG after rebuild."
        : "Inference check is non-fatal, matching the former shell lane's external API tolerance.",
    });

    expect(fs.existsSync(sandboxBackupRoot), `Backup directory missing: ${sandboxBackupRoot}`).toBe(
      true,
    );
    const leaks = listCredentialLeakPaths(sandboxBackupRoot, {
      extraSecrets: [apiKey, DISCORD_FAKE_TOKEN],
    });
    await artifacts.writeJson("phase-7-backup-credential-scan.json", {
      backupRoot: sandboxBackupRoot,
      leaks,
    });
    expect(leaks, "backup files must not contain credential-shaped values").toEqual([]);
  },
);
