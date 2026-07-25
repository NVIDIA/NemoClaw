// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { resolveDirectSandboxContainer } from "../../../src/lib/sandbox/privileged-exec";
import { readSandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import { type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  readJsonFileOr,
  restoreFile,
  snapshotFile,
  writeJsonFile,
} from "../fixtures/file-state.ts";
import {
  HERMES_REBUILD_SWAP_BYTES,
  needsHermesRebuildSwap,
  parseActiveSwapBytes,
} from "../fixtures/hermes-rebuild-swap.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { listCredentialLeakPaths } from "../fixtures/phases/state-validation.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  createRebuildHermesOldBaseResolutionMetadata,
  requireRebuildHermesCurrentBaseIdentity,
  verifyRebuildHermesCurrentBaseReuse,
  verifyRebuildHermesFinalBaseIdentity,
  verifyRebuildHermesOldBaseIsStale,
} from "./rebuild-hermes-base-identity.ts";
import { buildRebuildHermesChildEnv, planRebuildHermesBaseReuse } from "./rebuild-hermes-env.ts";
import { ensureRebuildHermesHostTools, hermesApiTokenDigest } from "./rebuild-hermes-host-tools.ts";
import {
  cleanupTrackedRebuildHermesImage,
  type RebuildHermesRegistryImageState,
  rebuildHermesRegistryImageState,
  requireRebuildHermesInitialImageTag,
} from "./rebuild-hermes-image-state.ts";
import {
  REBUILD_HERMES_OLD_BASE_FIXTURE,
  verifyRebuildHermesOldBaseFixture,
} from "./rebuild-hermes-old-base-fixture.ts";
import { buildRebuildHermesOldSandboxDockerfile } from "./rebuild-hermes-old-sandbox.ts";
import { REBUILD_HERMES_PHASES } from "./rebuild-hermes-phases.ts";
import { buildHermesRuntimeExecArgs } from "./rebuild-hermes-runtime-exec.ts";
import { buildRebuildHermesTimingSummary, describeRunnerClass } from "./rebuild-hermes-timing.ts";

// Protected PR E2E checks out the exact head while the trusted controller runs
// the base workflow. Older controller revisions therefore cannot provide the
// newly introduced CLI build and OpenShell install steps. Keep the test pinned
// to the exact checked-out launcher and bootstrap only what that controller
// revision omits; the PR workflow remains the canonical execution path.
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

// The rebuild regression invokes the checked-out CLI directly. Full install.sh
// coverage remains in hermes-e2e; this lane owns Docker base-image builds,
// OpenShell provider/sandbox commands, direct Hermes sandbox exec, curated
// local NemoClaw registry/session state, and `nemoclaw <name> rebuild --yes`.
// Literal interactive issue #3025 reproduction paths (`hermes rebuild`, modal
// prompt, and `Y` confirmation) remain outside this Vitest migration.

const HERMES_MANIFEST = path.join(REPO_ROOT, "agents", "hermes", "manifest.yaml");
const OLD_HERMES_VERSION = `v${REBUILD_HERMES_OLD_BASE_FIXTURE.hermesCalver}`;
const OLD_HERMES_REGISTRY_VERSION = OLD_HERMES_VERSION.slice(1);
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
const KANBAN_FILE = "/sandbox/.hermes/kanban.db";
const KANBAN_TASK_TITLE = `NEMOCLAW_REBUILD_KANBAN_${Date.now()}`;
const EXCLUDED_KANBAN_FILE = "/sandbox/.hermes/kanban/excluded-rebuild-marker.txt";
const DISCORD_PLACEHOLDER = "openshell:resolve:env:DISCORD_BOT_TOKEN";
const DISCORD_FAKE_TOKEN = "test-fake-discord-token-rebuild-e2e";
const PRE_REBUILD_API_SERVER_KEY = createHash("sha256").update(MARKER_CONTENT).digest("hex");
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
const CURRENT_BASE_REUSE_TAG = `nemoclaw-hermes-sandbox-base-local:e2e-current-${SANDBOX_NAME.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;

const KANBAN_TASK_PROBE = [
  "import json, os, sqlite3, sys",
  "db_path, expected = sys.argv[1:]",
  "db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)",
  "try:",
  "    tables = [row[0] for row in db.execute(\"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name\")]",
  "    titles = [row[0] for row in db.execute('SELECT title FROM tasks ORDER BY title')] if 'tasks' in tables else []",
  "    evidence = {",
  "        'path': db_path,",
  "        'sizeBytes': os.path.getsize(db_path),",
  "        'journalMode': db.execute('PRAGMA journal_mode').fetchone()[0],",
  "        'quickCheck': db.execute('PRAGMA quick_check').fetchone()[0],",
  "        'tables': tables,",
  "        'titles': titles,",
  "    }",
  "finally:",
  "    db.close()",
  "serialized = json.dumps(evidence, sort_keys=True)",
  "print(serialized)",
  "if expected not in titles:",
  "    raise SystemExit(f'missing expected task: {expected}; evidence={serialized}')",
].join("\n");

const ONBOARD_TIMEOUT_MS = 60 * 60_000;
const DOCKER_PULL_TIMEOUT_MS = 20 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;
const SANDBOX_CREATE_TIMEOUT_MS = 10 * 60_000;
const REBUILD_TIMEOUT_MS = 45 * 60_000;
const LIVE_TIMEOUT_MS = 70 * 60_000;
// Long Docker and onboard commands can become noisy when they wedge. Keep a
// generous diagnostic tail without letting a stuck child exhaust the hosted
// runner by growing the fixture's in-memory stdout/stderr buffers forever.
const LONG_COMMAND_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;
const HERMES_REBUILD_SWAP_FILE = "/mnt/nemoclaw-hermes-rebuild.swap";

async function ensureHermesRebuildSwap(host: HostCliClient): Promise<void> {
  const githubActions = process.env.GITHUB_ACTIONS === "true";
  if (!githubActions) return;

  const probeOptions = {
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  };
  const current = await host.command(
    "swapon",
    ["--show", "--bytes", "--noheadings", "--output", "SIZE"],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-before",
    },
  );
  expectExitZero(current, "inspect active swap before Hermes rebuild");
  if (
    !needsHermesRebuildSwap({
      activeSwapBytes: parseActiveSwapBytes(current.stdout),
      githubActions,
    })
  ) {
    return;
  }

  const provision = await host.command(
    "sudo",
    [
      "bash",
      "-c",
      `set -euo pipefail
swap_file="$1"
swap_size_bytes="$2"
swapoff "$swap_file" 2>/dev/null || true
rm -f "$swap_file"
fallocate -l "$swap_size_bytes" "$swap_file"
chmod 0600 "$swap_file"
mkswap "$swap_file"
swapon "$swap_file"`,
      "hermes-rebuild-swap",
      HERMES_REBUILD_SWAP_FILE,
      String(HERMES_REBUILD_SWAP_BYTES),
    ],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-provision",
      timeoutMs: 2 * 60_000,
    },
  );
  expectExitZero(provision, "provision swap for Hermes rebuild");

  const verified = await host.command(
    "swapon",
    ["--show", "--bytes", "--noheadings", "--output", "SIZE"],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-after",
    },
  );
  expectExitZero(verified, "inspect active swap after Hermes rebuild provisioning");
  expect(parseActiveSwapBytes(verified.stdout)).toBeGreaterThanOrEqual(HERMES_REBUILD_SWAP_BYTES);
}

function hermesRuntimeExecArgs(sandboxName: string, command: string[]): string[] {
  // `openshell sandbox exec` intentionally runs inside Landlock, which cannot
  // read the immutable `/opt/hermes` runtime. The rebuild contract needs to
  // seed and inspect that runtime in the managed Docker container itself.
  const containerId = resolveDirectSandboxContainer(sandboxName, "docker");
  return buildHermesRuntimeExecArgs(containerId, command);
}

function inspectKanbanTaskArgs(sandboxName: string): string[] {
  const script = [
    "import json, sqlite3, sys",
    "conn = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)",
    "rows = conn.execute('SELECT id, title, status FROM tasks WHERE title = ?', (sys.argv[2],)).fetchall()",
    "conn.close()",
    "print(json.dumps(rows))",
    "raise SystemExit(0 if rows else 1)",
  ].join("; ");
  return hermesRuntimeExecArgs(sandboxName, [
    "python3",
    "-c",
    script,
    KANBAN_FILE,
    KANBAN_TASK_TITLE,
  ]);
}

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

function expectEqual(actual: string | undefined, expected: string, message: string): void {
  switch (actual === expected) {
    case true:
      return;
    default:
      throw new Error(message);
  }
}

async function bestEffortPrecleanHermesResources(
  host: HostCliClient,
  apiKey: string | undefined,
  artifactName: string,
): Promise<void> {
  await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"], {
    artifactName: `${artifactName}-nemoclaw-destroy`,
    env: testEnv(apiKey),
    redactionValues: [apiKey ?? "", DISCORD_FAKE_TOKEN, PRE_REBUILD_API_SERVER_KEY],
    timeoutMs: 3 * 60_000,
  });
  await host.command(
    "bash",
    [
      "-lc",
      [
        "set +e",
        'if command -v openshell >/dev/null 2>&1; then openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true; fi',
        "if command -v openshell >/dev/null 2>&1; then openshell forward stop 8642 >/dev/null 2>&1 || true; fi",
        'if command -v openshell >/dev/null 2>&1; then openshell provider delete "$DISCORD_PROVIDER" >/dev/null 2>&1 || true; fi',
        'docker rmi "$OLD_BASE_TAG" >/dev/null 2>&1 || true',
        'docker rmi "$CURRENT_BASE_REUSE_TAG" >/dev/null 2>&1 || true',
        "exit 0",
      ].join("\n"),
    ],
    {
      artifactName,
      env: testEnv(apiKey, {
        DISCORD_PROVIDER: `${SANDBOX_NAME}-discord-bridge`,
        CURRENT_BASE_REUSE_TAG,
        OLD_BASE_TAG,
      }),
      redactionValues: [apiKey ?? "", DISCORD_FAKE_TOKEN, PRE_REBUILD_API_SERVER_KEY],
      timeoutMs: 3 * 60_000,
    },
  );
}

function hermesCleanupEnv(apiKey: string | undefined): NodeJS.ProcessEnv {
  return testEnv(apiKey, {
    CURRENT_BASE_REUSE_TAG,
    DISCORD_PROVIDER: `${SANDBOX_NAME}-discord-bridge`,
    OLD_BASE_TAG,
  });
}

function hermesCleanupRedactions(apiKey: string | undefined): string[] {
  return [apiKey ?? "", DISCORD_FAKE_TOKEN, PRE_REBUILD_API_SERVER_KEY];
}

async function cleanupHermesNemoClawSandbox(
  host: HostCliClient,
  apiKey: string | undefined,
): Promise<void> {
  const result = await host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "cleanup-hermes-rebuild-resources-nemoclaw-destroy",
    env: hermesCleanupEnv(apiKey),
    redactionValues: hermesCleanupRedactions(apiKey),
    timeoutMs: 3 * 60_000,
  });
  assertCleanupSucceededOrAbsent(
    result,
    /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/iu,
    `cleanup Hermes rebuild sandbox ${SANDBOX_NAME}`,
  );
}

async function cleanupHermesDiscordProvider(
  host: HostCliClient,
  apiKey: string | undefined,
): Promise<void> {
  const provider = `${SANDBOX_NAME}-discord-bridge`;
  const result = await host.command("openshell", ["provider", "delete", provider], {
    artifactName: "cleanup-hermes-rebuild-resources-provider-delete",
    env: hermesCleanupEnv(apiKey),
    redactionValues: hermesCleanupRedactions(apiKey),
    timeoutMs: 3 * 60_000,
  });
  assertCleanupSucceededOrAbsent(
    result,
    /\bNotFound\b|provider[^\n]*(?:not found|does not exist)|No provider|No active gateway|No gateway metadata/iu,
    `cleanup Hermes Discord provider ${provider}`,
  );
}

async function cleanupOldHermesBaseImage(
  host: HostCliClient,
  apiKey: string | undefined,
): Promise<void> {
  await removeHermesFixtureImage(host, apiKey, OLD_BASE_TAG, {
    artifactName: "cleanup-hermes-rebuild-resources-docker-rmi-old-base",
    label: `cleanup old Hermes base image ${OLD_BASE_TAG}`,
  });
}

async function removeHermesFixtureImage(
  host: HostCliClient,
  apiKey: string | undefined,
  imageTag: string,
  options: { artifactName: string; label: string },
): Promise<void> {
  const result = await host.command("docker", ["image", "rm", imageTag], {
    artifactName: options.artifactName,
    env: hermesCleanupEnv(apiKey),
    redactionValues: hermesCleanupRedactions(apiKey),
    timeoutMs: 3 * 60_000,
  });
  assertCleanupSucceededOrAbsent(
    result,
    /No such image|No such object|image .* not found/iu,
    options.label,
  );
}

async function waitForSandboxReady(
  host: HostCliClient,
  apiKey: string,
  artifactPrefix: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const list = await host.command("openshell", ["sandbox", "list"], {
      artifactName: `${artifactPrefix}-sandbox-list-${attempt}`,
      env: testEnv(apiKey),
      redactionValues: [apiKey, PRE_REBUILD_API_SERVER_KEY],
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

function seedRegistryAndSession(
  dashboardPort: number,
  imageState: RebuildHermesRegistryImageState,
): SessionArtifactSummary {
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
    ...imageState,
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

function registrySandbox(): Record<string, unknown> {
  const sandbox = readJsonFileOr<RegistryData>(REGISTRY_FILE, {}).sandboxes?.[SANDBOX_NAME];
  expect(sandbox, `registry entry missing for ${SANDBOX_NAME}`).toBeDefined();
  return sandbox as Record<string, unknown>;
}

async function prepareCurrentBaseReuse(
  host: HostCliClient,
  redactionValues: string[],
  currentBase: ReturnType<typeof requireRebuildHermesCurrentBaseIdentity>,
  currentBaseSourceInspect: ShellProbeResult,
  plan: ReturnType<typeof planRebuildHermesBaseReuse>,
  trackPreparedImage: (imageTag: string) => void,
): Promise<ReturnType<typeof verifyRebuildHermesCurrentBaseReuse> | null> {
  switch (plan) {
    case null:
      return null;
    default: {
      const tagCurrentBase = await host.command(
        "docker",
        ["tag", plan.sourceRef, plan.preparedRef],
        {
          artifactName: "phase-1-tag-current-hermes-base-for-reuse",
          env: buildAvailabilityProbeEnv(),
          redactionValues,
          timeoutMs: OPENSHELL_TIMEOUT_MS,
        },
      );
      expectExitZero(tagCurrentBase, "tag current Hermes base for rebuild reuse");
      trackPreparedImage(plan.preparedRef);
      const currentBaseReuseInspect = await host.command(
        "docker",
        ["image", "inspect", "--format", "{{json .}}", plan.preparedRef],
        {
          artifactName: "phase-1-inspect-current-hermes-base-reuse-alias",
          env: buildAvailabilityProbeEnv(),
          redactionValues,
          timeoutMs: OPENSHELL_TIMEOUT_MS,
        },
      );
      expectExitZero(currentBaseReuseInspect, "inspect current Hermes base reuse alias");
      const evidence = verifyRebuildHermesCurrentBaseReuse(
        currentBase,
        plan.preparedRef,
        currentBaseSourceInspect.stdout.trim(),
        currentBaseReuseInspect.stdout.trim(),
      );
      expect(evidence.pinnedReuseRef).toBe(
        `nemoclaw-hermes-sandbox-base-local:image-${currentBase.imageId.slice("sha256:".length)}`,
      );
      return evidence;
    }
  }
}

function verifySeededOldBaseResolution(
  staleBaseMode: boolean,
  seededResolution: ReturnType<typeof readSandboxBaseImageResolutionMetadata>,
  oldBaseResolution: ReturnType<typeof createRebuildHermesOldBaseResolutionMetadata>,
  currentBaseResolution: ReturnType<typeof requireRebuildHermesCurrentBaseIdentity>,
  oldBaseInspectJson: string,
): ReturnType<typeof verifyRebuildHermesOldBaseIsStale> | null {
  switch (staleBaseMode) {
    case true:
      expect(
        seededResolution,
        "synthetic old Hermes sandbox must retain its stale immutable base identity",
      ).toEqual(oldBaseResolution);
      return verifyRebuildHermesOldBaseIsStale(
        seededResolution ?? fail("synthetic old Hermes sandbox base identity disappeared"),
        currentBaseResolution,
        oldBaseInspectJson,
      );
    case false:
      expect(
        seededResolution,
        "normal rebuild lane must not manufacture a stale base-resolution hint",
      ).toBeNull();
      return null;
  }
}

test(STALE_BASE_REBUILD
  ? "rebuild-hermes: stale base cache is refreshed while Hermes state survives rebuild"
  : "rebuild-hermes: historical base rebuild preserves messaging state and selects current base", {
  timeout: LIVE_TIMEOUT_MS,
  meta: { e2ePhases: REBUILD_HERMES_PHASES },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const redactionValues = [apiKey, DISCORD_FAKE_TOKEN, PRE_REBUILD_API_SERVER_KEY];
  const expectedVersion = expectedHermesVersion();

  const registrySnapshot = snapshotFile(REGISTRY_FILE);
  const sessionSnapshot = snapshotFile(SESSION_FILE);
  const sandboxBackupRoot = path.join(BACKUP_ROOT, SANDBOX_NAME);
  cleanup.trackDisposable(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
    restoreFile(REGISTRY_FILE, registrySnapshot);
    restoreFile(SESSION_FILE, sessionSnapshot);
    fs.rmSync(sandboxBackupRoot, { recursive: true, force: true });
  });
  await artifacts.writeJson("contract.json", {
    staleBaseMode: STALE_BASE_REBUILD,
    sandboxName: SANDBOX_NAME,
    oldHermesVersion: OLD_HERMES_VERSION,
    oldBaseFixture: REBUILD_HERMES_OLD_BASE_FIXTURE,
    expectedHermesVersion: expectedVersion,
    markerFile: MARKER_FILE,
    preservedBoundaries: [
      "checked-out NemoClaw CLI non-interactive Hermes onboard",
      "phase 1 current Hermes base resolution plus immutable old Hermes base fixture",
      "openshell provider create/update and sandbox create/exec/list",
      "curated local ~/.nemoclaw registry and onboard-session rebuild metadata",
      "real nemoclaw <sandbox> rebuild --yes --verbose",
      "Hermes .env/config.yaml messaging placeholder preservation",
      "backup credential leak scan under ~/.nemoclaw/rebuild-backups",
    ],
    outOfScope: [
      "install.sh behavior retained by hermes-e2e",
      "interactive hermes rebuild modal prompt and Y confirmation",
    ],
  });

  expect(
    fs.existsSync(CLI_ENTRYPOINT),
    "bin/nemoclaw.js missing — build the checked-out CLI before live rebuild coverage",
  ).toBe(true);
  expect(
    path.resolve(host.commandPath),
    "rebuild-Hermes must invoke the checked-out CLI through NEMOCLAW_CLI_BIN",
  ).toBe(CLI_ENTRYPOINT);
  await ensureRebuildHermesHostTools(host);
  await ensureHermesRebuildSwap(host);

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

  await bestEffortPrecleanHermesResources(host, apiKey, "pre-cleanup-hermes-rebuild-resources");

  let phase1ImageTag: string | null = null;
  let currentBaseReuseTag: string | null = null;
  let currentBaseSourceInspect: ShellProbeResult | null = null;
  let staleBaseClassification: ReturnType<typeof verifyRebuildHermesOldBaseIsStale> | null = null;
  let oldSandboxImageState: RebuildHermesRegistryImageState | null = null;
  cleanup.trackDisposable(`remove old Hermes base image ${OLD_BASE_TAG}`, () =>
    cleanupOldHermesBaseImage(host, apiKey),
  );
  cleanup.trackDisposable("remove current Hermes base reuse alias", () =>
    cleanupTrackedRebuildHermesImage(currentBaseReuseTag, (imageTag) =>
      removeHermesFixtureImage(host, apiKey, imageTag, {
        artifactName: "cleanup-hermes-rebuild-resources-docker-rmi-current-base-reuse",
        label: `cleanup current Hermes base reuse alias ${imageTag}`,
      }),
    ),
  );
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-hermes-rebuild-resources-gateway",
    env: hermesCleanupEnv(apiKey),
    redactionValues: hermesCleanupRedactions(apiKey),
    timeoutMs: 3 * 60_000,
  });
  cleanup.trackDisposable(`remove Hermes Discord provider for ${SANDBOX_NAME}`, () =>
    cleanupHermesDiscordProvider(host, apiKey),
  );
  cleanup.trackForward(host, 8642, {
    artifactName: "cleanup-hermes-rebuild-resources-forward-stop",
    env: hermesCleanupEnv(apiKey),
    redactionValues: hermesCleanupRedactions(apiKey),
    timeoutMs: 3 * 60_000,
  });
  // Cleanup is LIFO: remove the sandbox before reclaiming its exact image tags,
  // while the gateway/provider/forward remain available for sandbox teardown.
  cleanup.trackDisposable("remove initial Hermes fixture image", () =>
    cleanupTrackedRebuildHermesImage(phase1ImageTag, (imageTag) =>
      removeHermesFixtureImage(host, apiKey, imageTag, {
        artifactName: "cleanup-hermes-rebuild-resources-docker-rmi-initial-image",
        label: `cleanup initial Hermes fixture image ${imageTag}`,
      }),
    ),
  );
  cleanup.trackDisposable("remove old derived Hermes fixture image", () =>
    cleanupTrackedRebuildHermesImage(oldSandboxImageState?.imageTag ?? null, (imageTag) =>
      removeHermesFixtureImage(host, apiKey, imageTag, {
        artifactName: "cleanup-hermes-rebuild-resources-docker-rmi-old-derived-image",
        label: `cleanup old derived Hermes fixture image ${imageTag}`,
      }),
    ),
  );
  cleanup.trackDisposable(`delete Hermes rebuild OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-hermes-rebuild-resources-openshell-sandbox-delete",
      env: hermesCleanupEnv(apiKey),
      redactionValues: hermesCleanupRedactions(apiKey),
      timeoutMs: 3 * 60_000,
    }),
  );
  cleanup.trackDisposable(`destroy Hermes rebuild sandbox ${SANDBOX_NAME}`, () =>
    cleanupHermesNemoClawSandbox(host, apiKey),
  );

  progress.phase("onboard the current Hermes sandbox");
  const cliProbe = await host.nemoclaw(["--help"], {
    artifactName: "phase-1-cli-probe",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: 30_000,
  });
  expectExitZero(cliProbe, "checked-out NemoClaw CLI");

  const openshellProbe = await host.command("openshell", ["--version"], {
    artifactName: "phase-1-openshell-probe",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: 30_000,
  });
  expectExitZero(openshellProbe, "workflow-installed OpenShell CLI");

  const onboard = await host.nemoclaw(["onboard", "--non-interactive"], {
    artifactName: "phase-1-onboard-current-hermes",
    cwd: REPO_ROOT,
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: ONBOARD_TIMEOUT_MS,
    captureLimitBytes: LONG_COMMAND_CAPTURE_LIMIT_BYTES,
    onOutput: progress.onOutput,
  });
  expectExitZero(onboard, "checked-out NemoClaw Hermes onboard");

  const gatewayProbe = await host.command("openshell", ["gateway", "info", "-g", "nemoclaw"], {
    artifactName: "phase-1-gateway-probe",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: 30_000,
  });
  expectExitZero(gatewayProbe, "NemoClaw onboard must leave a reusable 'nemoclaw' gateway");

  const phase1DashboardPort = registrySandbox().dashboardPort;
  expect(
    typeof phase1DashboardPort === "number" &&
      Number.isInteger(phase1DashboardPort) &&
      phase1DashboardPort > 0 &&
      phase1DashboardPort <= 65535,
    "initial Hermes onboard must persist the dashboard port used by authoritative rebuild",
  ).toBe(true);
  phase1ImageTag = requireRebuildHermesInitialImageTag(registrySandbox().imageTag, SANDBOX_NAME);
  const phase1BaseResolution = requireRebuildHermesCurrentBaseIdentity(
    readSandboxBaseImageResolutionMetadata(phase1ImageTag),
  );
  currentBaseSourceInspect = await host.command(
    "docker",
    ["image", "inspect", "--format", "{{json .}}", phase1BaseResolution.ref],
    {
      artifactName: "phase-1-inspect-current-hermes-base-source",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(currentBaseSourceInspect, "inspect phase 1 current Hermes base source");
  const baseReusePlan = planRebuildHermesBaseReuse(
    STALE_BASE_REBUILD,
    phase1BaseResolution,
    CURRENT_BASE_REUSE_TAG,
  );
  const currentBaseReuseEvidence = await prepareCurrentBaseReuse(
    host,
    redactionValues,
    phase1BaseResolution,
    currentBaseSourceInspect,
    baseReusePlan,
    (imageTag) => {
      currentBaseReuseTag = imageTag;
    },
  );
  await artifacts.writeJson("phase-1-owned-image.json", {
    imageTag: phase1ImageTag,
    baseResolution: phase1BaseResolution,
    reuseAlias: currentBaseReuseEvidence
      ? { imageTag: CURRENT_BASE_REUSE_TAG, ...currentBaseReuseEvidence }
      : null,
  });

  await sandbox.cleanupSandbox(SANDBOX_NAME, {
    artifactName: "phase-1-delete-current-sandbox",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: OPENSHELL_TIMEOUT_MS,
  });
  await removeHermesFixtureImage(host, apiKey, phase1ImageTag, {
    artifactName: "phase-1-remove-initial-hermes-image",
    label: `remove initial Hermes fixture image ${phase1ImageTag}`,
  });
  await host.command("openshell", ["forward", "stop", "8642"], {
    artifactName: "phase-1-stop-hermes-forward",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: OPENSHELL_TIMEOUT_MS,
  });

  progress.phase("pull and verify the historical Hermes base fixture");
  const pullOldBase = await host.command(
    "docker",
    ["pull", REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef],
    {
      artifactName: "phase-2-docker-pull-old-hermes-base-fixture",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: DOCKER_PULL_TIMEOUT_MS,
      captureLimitBytes: LONG_COMMAND_CAPTURE_LIMIT_BYTES,
      onOutput: progress.onOutput,
    },
  );
  expectExitZero(pullOldBase, `pull immutable old Hermes base ${OLD_HERMES_VERSION}`);

  const oldBaseLabels = await host.command(
    "docker",
    [
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
    ],
    {
      artifactName: "phase-2-inspect-old-hermes-base-fixture-labels",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(oldBaseLabels, "inspect immutable old Hermes base fixture labels");

  const oldBaseIdentity = await host.command(
    "docker",
    ["image", "inspect", "--format", "{{json .}}", REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef],
    {
      artifactName: "phase-2-inspect-old-hermes-base-fixture-identity",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(oldBaseIdentity, "inspect immutable old Hermes base fixture identity");

  const oldBaseVersion = await host.command(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "hermes",
      REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
      "--version",
    ],
    {
      artifactName: "phase-2-probe-old-hermes-base-fixture-version",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(oldBaseVersion, "probe immutable old Hermes base fixture version");

  const oldBaseGlibcVersion = await host.command(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/bin/ldd",
      REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
      "--version",
    ],
    {
      artifactName: "phase-2-probe-old-hermes-base-fixture-glibc",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(oldBaseGlibcVersion, "probe immutable old Hermes base fixture glibc version");

  const oldBaseEvidence = verifyRebuildHermesOldBaseFixture(
    REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef,
    oldBaseLabels.stdout.trim(),
    resultText(oldBaseVersion),
  );
  const oldBaseResolutionMetadata = createRebuildHermesOldBaseResolutionMetadata(
    oldBaseIdentity.stdout.trim(),
    resultText(oldBaseGlibcVersion),
  );
  await artifacts.writeJson("phase-2-old-base-fixture.json", {
    ...oldBaseEvidence,
    baseResolution: oldBaseResolutionMetadata,
  });

  const tagOldBase = await host.command(
    "docker",
    ["tag", REBUILD_HERMES_OLD_BASE_FIXTURE.imageRef, OLD_BASE_TAG],
    {
      artifactName: "phase-2-tag-old-hermes-base-fixture",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(tagOldBase, "tag immutable old Hermes base fixture for sandbox creation");

  const oldDockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-hermes-"));
  const oldDockerfile = path.join(oldDockerfileDir, "Dockerfile");
  fs.writeFileSync(
    oldDockerfile,
    buildRebuildHermesOldSandboxDockerfile({
      baseTag: OLD_BASE_TAG,
      baseResolutionMetadata: STALE_BASE_REBUILD ? oldBaseResolutionMetadata : null,
      apiServerKey: PRE_REBUILD_API_SERVER_KEY,
      discordPlaceholder: DISCORD_PLACEHOLDER,
      kanbanTaskTitle: KANBAN_TASK_TITLE,
    }),
    "utf8",
  );
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

    progress.phase("create the historical Hermes sandbox");
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
        captureLimitBytes: LONG_COMMAND_CAPTURE_LIMIT_BYTES,
        onOutput: progress.onOutput,
      },
    );
    expectExitZero(createOldSandbox, "create old Hermes sandbox");
    oldSandboxImageState = rebuildHermesRegistryImageState(resultText(createOldSandbox));
  } finally {
    fs.rmSync(oldDockerfileDir, { recursive: true, force: true });
  }
  const seededOldSandboxImageState =
    oldSandboxImageState ?? fail("old Hermes sandbox create did not produce managed image state");
  await waitForSandboxReady(host, apiKey, "phase-3");
  const seededOldBaseResolution = readSandboxBaseImageResolutionMetadata(
    seededOldSandboxImageState.imageTag,
  );
  staleBaseClassification = verifySeededOldBaseResolution(
    STALE_BASE_REBUILD,
    seededOldBaseResolution,
    oldBaseResolutionMetadata,
    phase1BaseResolution,
    oldBaseIdentity.stdout.trim(),
  );
  await artifacts.writeJson("phase-3-old-sandbox-base-identity.json", {
    resolutionMetadata: seededOldBaseResolution,
    staleClassification: staleBaseClassification,
  });
  await removeHermesFixtureImage(host, apiKey, OLD_BASE_TAG, {
    artifactName: "phase-3-release-old-hermes-base-tag",
    label: `release old Hermes base tag ${OLD_BASE_TAG}`,
  });

  progress.phase("seed persistent Hermes state and registry metadata");
  const seededKanban = await host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      SANDBOX_NAME,
      "--",
      "/usr/bin/python3",
      "-c",
      KANBAN_TASK_PROBE,
      KANBAN_FILE,
      KANBAN_TASK_TITLE,
    ],
    {
      artifactName: "phase-4-verify-seeded-kanban",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(seededKanban, "verify historical Hermes kanban seed before rebuild");
  expect(resultText(seededKanban)).toContain(KANBAN_TASK_TITLE);
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

  const writeExcludedKanbanMarker = await host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      SANDBOX_NAME,
      "--",
      "sh",
      "-c",
      [
        `mkdir -p ${shellQuote(path.dirname(EXCLUDED_KANBAN_FILE))}`,
        `printf '%s' ${shellQuote(MARKER_CONTENT)} > ${shellQuote(EXCLUDED_KANBAN_FILE)}`,
      ].join(" && "),
    ],
    {
      artifactName: "phase-4-write-excluded-kanban-marker",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(writeExcludedKanbanMarker, "write excluded Hermes kanban marker");

  const seededKanbanDb = await host.command("docker", inspectKanbanTaskArgs(SANDBOX_NAME), {
    artifactName: "phase-4-inspect-seeded-kanban-db",
    env: testEnv(apiKey),
    redactionValues,
    timeoutMs: OPENSHELL_TIMEOUT_MS,
  });
  expectExitZero(seededKanbanDb, "inspect seeded Hermes kanban database");
  expect(resultText(seededKanbanDb)).toContain(KANBAN_TASK_TITLE);

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

  const sessionSummary = seedRegistryAndSession(
    phase1DashboardPort as number,
    seededOldSandboxImageState,
  );
  const seededRegistry = registrySandbox();
  expect(
    seededRegistry.imageTag,
    "curated rebuild registry must retain the exact old derived image tag for cleanup",
  ).toBe(seededOldSandboxImageState.imageTag);
  await artifacts.writeJson("phase-4-registry-session-summary.json", {
    registryVersion: seededRegistry.agentVersion,
    dashboardPort: seededRegistry.dashboardPort,
    imageTag: seededRegistry.imageTag,
    registryInference: {
      provider: seededRegistry.provider,
      endpointUrl: seededRegistry.endpointUrl,
      credentialEnv: seededRegistry.credentialEnv,
      preferredInferenceApi: seededRegistry.preferredInferenceApi,
    },
    session: sessionSummary,
  });
  const preRebuildApiTokenDigest = await hermesApiTokenDigest(
    host,
    SANDBOX_NAME,
    "phase-4-api-token-before-rebuild",
    testEnv(apiKey, { SANDBOX_NAME }),
    redactionValues,
    OPENSHELL_TIMEOUT_MS,
  );

  progress.phase("prepare the current-base rebuild condition");
  switch (STALE_BASE_REBUILD) {
    case false: {
      await artifacts.writeText(
        "phase-5-current-base-reuse.txt",
        `Reusing phase 1 Hermes base ${phase1BaseResolution.ref} (${phase1BaseResolution.digest ?? phase1BaseResolution.imageId}) through verified alias ${CURRENT_BASE_REUSE_TAG}; rebuild must canonicalize it to the official digest without constructing it again.\n`,
      );
      break;
    }
    case true: {
      const classification =
        staleBaseClassification ?? fail("stale rebuild lane did not classify its old base hint");
      await artifacts.writeText(
        "phase-5-stale-base-note.txt",
        `Recorded ${OLD_HERMES_VERSION} as the sandbox's validated old resolution hint; rebuild must reject its ${classification.reason} and refresh to ${phase1BaseResolution.digest ?? phase1BaseResolution.imageId}.\n`,
      );
      break;
    }
  }

  progress.phase("rebuild the Hermes sandbox");
  const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"], {
    artifactName: "phase-6-nemoclaw-rebuild-hermes",
    env: testEnv(apiKey, {
      NEMOCLAW_REBUILD_VERBOSE: "1",
      ...baseReusePlan?.childEnv,
    }),
    redactionValues,
    timeoutMs: REBUILD_TIMEOUT_MS,
    captureLimitBytes: LONG_COMMAND_CAPTURE_LIMIT_BYTES,
    onOutput: progress.onOutput,
  });
  expectExitZero(rebuild, "nemoclaw rebuild Hermes sandbox");
  const rebuildOutput = resultText(rebuild);
  expect(rebuildOutput).toContain("Hermes API bearer token changed during rebuild");
  expect(rebuildOutput).toContain(`nemoclaw ${SANDBOX_NAME} gateway-token --quiet`);
  expect(rebuildOutput).toContain(`Using Hermes Agent base image: ${phase1BaseResolution.ref}`);
  expect(rebuildOutput).not.toContain("Rebuilding Hermes Agent base image");
  await waitForSandboxReady(host, apiKey, "phase-6-post-rebuild");

  const backupPathText = rebuildOutput.match(/^\s*Backup:\s+(.+)$/mu)?.[1]?.trim();
  const rebuildBackupPath = backupPathText
    ? path.resolve(backupPathText)
    : fail("Hermes rebuild did not report its state backup path");
  const resolvedBackupRoot = path.resolve(sandboxBackupRoot);
  expect(
    rebuildBackupPath.startsWith(`${resolvedBackupRoot}${path.sep}`),
    "Hermes rebuild backup must remain under the test-owned sandbox backup root",
  ).toBe(true);
  const backedUpKanbanDatabase = await host.command(
    "/usr/bin/python3",
    [
      "-c",
      KANBAN_TASK_PROBE,
      path.join(rebuildBackupPath, path.basename(KANBAN_FILE)),
      KANBAN_TASK_TITLE,
    ],
    {
      artifactName: "phase-6-verify-backed-up-kanban-database",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(backedUpKanbanDatabase, "verify backed-up Hermes kanban database");
  expect(resultText(backedUpKanbanDatabase)).toContain(KANBAN_TASK_TITLE);

  const oldImageInspect = await host.command(
    "docker",
    ["image", "inspect", seededOldSandboxImageState.imageTag],
    {
      artifactName: "phase-6-old-derived-image-removed",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expect(
    typeof oldImageInspect.exitCode === "number" && oldImageInspect.exitCode > 0,
    resultText(oldImageInspect),
  ).toBe(true);
  expect(resultText(oldImageInspect)).toMatch(/No such (?:image|object)(?::|\s)/iu);

  progress.phase("validate upgraded state inference and backup hygiene");
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
    "docker",
    hermesRuntimeExecArgs(SANDBOX_NAME, ["hermes", "--version"]),
    {
      artifactName: "phase-7-hermes-version-after-rebuild",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(hermesVersion, "Hermes version after rebuild");
  const hermesVersionText = resultText(hermesVersion);
  const actualHermesVersion = hermesVersionText.match(/v(\d+\.\d+\.\d+)/)?.[1];
  expectEqual(
    actualHermesVersion,
    expectedVersion,
    `Hermes version output did not include expected release ${expectedVersion}: ${hermesVersionText}`,
  );

  const restoredKanbanDatabase = await host.command(
    "openshell",
    [
      "sandbox",
      "exec",
      "--name",
      SANDBOX_NAME,
      "--",
      "/usr/bin/python3",
      "-c",
      KANBAN_TASK_PROBE,
      KANBAN_FILE,
      KANBAN_TASK_TITLE,
    ],
    {
      artifactName: "phase-7-verify-restored-kanban-database",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(restoredKanbanDatabase, "verify restored Hermes kanban database");
  expect(resultText(restoredKanbanDatabase)).toContain(KANBAN_TASK_TITLE);

  const restoredKanban = await host.command(
    "docker",
    hermesRuntimeExecArgs(SANDBOX_NAME, ["hermes", "kanban", "list", "--json"]),
    {
      artifactName: "phase-7-list-kanban-after-rebuild",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(restoredKanban, "list Hermes kanban tasks after rebuild");
  expect(resultText(restoredKanban)).toContain(KANBAN_TASK_TITLE);

  const excludedKanbanState = await host.command(
    "openshell",
    ["sandbox", "exec", "--name", SANDBOX_NAME, "--", "test", "!", "-e", EXCLUDED_KANBAN_FILE],
    {
      artifactName: "phase-7-verify-excluded-kanban-state",
      env: testEnv(apiKey),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(excludedKanbanState, "verify excluded Hermes kanban state was not restored");

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

  const postRebuildApiTokenDigest = await hermesApiTokenDigest(
    host,
    SANDBOX_NAME,
    "phase-7-api-token-after-rebuild",
    testEnv(apiKey, { SANDBOX_NAME }),
    redactionValues,
    OPENSHELL_TIMEOUT_MS,
  );
  const stablePostRebuildApiTokenDigest = await hermesApiTokenDigest(
    host,
    SANDBOX_NAME,
    "phase-7-api-token-stability-check",
    testEnv(apiKey, { SANDBOX_NAME }),
    redactionValues,
    OPENSHELL_TIMEOUT_MS,
  );
  expect(postRebuildApiTokenDigest).not.toBe(preRebuildApiTokenDigest);
  expect(stablePostRebuildApiTokenDigest).toBe(postRebuildApiTokenDigest);

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

  const rebuiltRegistry = registrySandbox();
  const updatedRegistryVersion = rebuiltRegistry.agentVersion;
  expect(updatedRegistryVersion).toEqual(expect.any(String));
  expect(updatedRegistryVersion).not.toBe(OLD_HERMES_REGISTRY_VERSION);
  const rebuiltImageTag = requireRebuildHermesInitialImageTag(
    rebuiltRegistry.imageTag,
    SANDBOX_NAME,
  );
  expect(
    rebuiltImageTag,
    "Hermes rebuild must replace the seeded derived image with a new managed image",
  ).not.toBe(seededOldSandboxImageState.imageTag);
  const finalImageInspect = await host.command(
    "docker",
    ["image", "inspect", "--format", "{{json .}}", rebuiltImageTag],
    {
      artifactName: "phase-7-inspect-final-hermes-base-identity",
      env: buildAvailabilityProbeEnv(),
      redactionValues,
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
  expectExitZero(finalImageInspect, "inspect final Hermes base identity");
  const finalBaseEvidence = verifyRebuildHermesFinalBaseIdentity(
    STALE_BASE_REBUILD,
    phase1BaseResolution,
    oldBaseResolutionMetadata,
    currentBaseSourceInspect?.stdout.trim() ??
      fail("phase 1 current Hermes base inspection disappeared"),
    oldBaseIdentity.stdout.trim(),
    finalImageInspect.stdout.trim(),
  );
  await artifacts.writeJson("phase-7-final-base-identity.json", {
    rebuiltImageTag,
    resolutionMetadata: readSandboxBaseImageResolutionMetadata(rebuiltImageTag),
    ...finalBaseEvidence,
  });

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
    extraSecrets: [apiKey, DISCORD_FAKE_TOKEN, PRE_REBUILD_API_SERVER_KEY],
  });
  await artifacts.writeJson("phase-7-backup-credential-scan.json", {
    backupRoot: sandboxBackupRoot,
    leaks,
  });

  // Capture per-phase and total wall time tagged with the runner class so
  // before/after comparisons for #7144 stay on the same runner class. Written
  // before the final gate so the timing artifact survives an assertion failure.
  await artifacts.writeJson(
    "rebuild-hermes-timing.json",
    buildRebuildHermesTimingSummary({
      lane: STALE_BASE_REBUILD ? "stale-base" : "normal",
      timeline: progress.timeline(),
      runnerClass: describeRunnerClass(),
      capturedAtIso: new Date().toISOString(),
    }),
  );

  expect(leaks, "backup files must not contain credential-shaped values").toEqual([]);
});
