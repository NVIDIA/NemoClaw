// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote";

// Direct Vitest replacement coverage for test/e2e/test-rebuild-openclaw.sh.
// The contract stays intentionally local to this live test: build an older
// OpenClaw base image, create a sandbox from it through the real OpenShell CLI,
// seed workspace/policy/gateway-token state, run the real `nemoclaw rebuild`,
// and verify the rebuilt sandbox preserved state while rotating secrets.
//
// Simplicity boundary: no new registry, fixture family, or migration ledger.
// The legacy bash lane remains wired in nightly-e2e.yaml until #5098's cleanup
// phase intentionally retires converted shell entry points.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const BLUEPRINT_RELPATH = path.join("nemoclaw-blueprint", "blueprint.yaml");
const BLUEPRINT = path.join(REPO_ROOT, BLUEPRINT_RELPATH);
const OLD_OPENCLAW_VERSION = "2026.3.11";
const MARKER_FILE = "/sandbox/.openclaw/workspace/rebuild-marker.txt";
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const BACKUP_ROOT = path.join(os.homedir(), ".nemoclaw", "rebuild-backups");
const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const TEST_SANDBOX_PREFIX = "e2e-rebuild-openclaw";
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
validateSandboxName(SANDBOX_NAME);
if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
  throw new Error(
    `rebuild-openclaw live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
  );
}

const POLICY_PRESETS = ["npm", "pypi", "telegram"] as const;

const MARKER_CONTENT = `REBUILD_OC_E2E_${Date.now()}`;
const PRE_REBUILD_GATEWAY_TOKEN = `nemoclaw-e2e-old-gateway-token-${MARKER_CONTENT}`;
const OLD_BASE_TAG = `nemoclaw-old-base:${SANDBOX_NAME.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;

const ONBOARD_TIMEOUT_MS = 20 * 60_000;
const DOCKER_BUILD_TIMEOUT_MS = 35 * 60_000;
const REBUILD_TIMEOUT_MS = 30 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;

interface SeedGatewayTokenResult {
  seeded: boolean;
  hashReferencesConfig: boolean;
}

interface GatewayTokenRotationResult {
  tokenPresent: boolean;
  tokenRotated: boolean;
  runtimeMatchesConfig: boolean;
  runtimeStillOld: boolean;
  hashReferencesConfig: boolean;
  hashChanged: boolean;
  hashValid: boolean;
}

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label} failed:\n${resultText(result)}`).toBe(0);
}

function isRetryableOnboardEndpointFailure(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return (
    /endpoint validation failed|Chat Completions API validation/i.test(text) &&
    /HTTP 429|timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|502|503|504|temporar/i.test(
      text,
    )
  );
}

function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface FileSnapshot {
  exists: boolean;
  content?: string;
}

function snapshotFile(file: string): FileSnapshot {
  return fs.existsSync(file)
    ? { exists: true, content: fs.readFileSync(file, "utf8") }
    : { exists: false };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot.content ?? "", "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerContextEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

function cliEnv(apiKey: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return dockerContextEnv({
    NVIDIA_API_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    ...extra,
  });
}

function openshellBestEffort(
  host: HostCliClient,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  const quotedArgs = args.map(shellQuote).join(" ");
  return host.command(
    "bash",
    ["-lc", `command -v openshell >/dev/null 2>&1 && openshell ${quotedArgs} || true`],
    {
      artifactName,
      env: dockerContextEnv(),
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
}

function pythonExecArgs(script: string): string[] {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return ["python3", "-c", `import base64; exec(base64.b64decode('${encoded}'))`];
}

function createOldBaseBuildContext(): string {
  const buildContext = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-base-"));
  fs.mkdirSync(path.join(buildContext, path.dirname(BLUEPRINT_RELPATH)), { recursive: true });
  const original = fs.readFileSync(BLUEPRINT, "utf8");
  const minOpenClawVersion = /^(\s*min_openclaw_version:\s*).*/m;
  expect(
    minOpenClawVersion.test(original),
    "blueprint min_openclaw_version line was not found",
  ).toBe(true);
  const lowered = original.replace(minOpenClawVersion, `$1"${OLD_OPENCLAW_VERSION}"`);
  fs.writeFileSync(path.join(buildContext, BLUEPRINT_RELPATH), lowered, "utf8");
  return buildContext;
}

async function waitForSandboxReady(sandbox: {
  list(options?: object): Promise<ShellProbeResult>;
}): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const list = await sandbox.list({
      artifactName: `phase-3-sandbox-list-${attempt}`,
      env: dockerContextEnv(),
      timeoutMs: 30_000,
    });
    if (new RegExp(`${SANDBOX_NAME}.*Ready`).test(list.stdout)) return;
    await sleep(5_000);
  }
  throw new Error(`sandbox ${SANDBOX_NAME} did not become Ready`);
}

async function configureGatewayInferenceRoute(
  host: HostCliClient,
  apiKey: string,
): Promise<ShellProbeResult> {
  const model = shellQuote(DEFAULT_MODEL);
  return host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        "if openshell provider get nvidia-prod >/dev/null 2>&1; then",
        "  openshell provider update nvidia-prod --credential NVIDIA_API_KEY",
        "else",
        "  openshell provider create --name nvidia-prod --type nvidia --credential NVIDIA_API_KEY",
        "fi",
        `openshell inference set --no-verify --provider nvidia-prod --model ${model}`,
      ].join("\n"),
    ],
    {
      artifactName: "phase-4-configure-gateway-inference-route",
      env: cliEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    },
  );
}

function seedRegistryAndSession(): void {
  // The legacy rebuild regression requires an intentionally old OpenClaw sandbox
  // that NemoClaw cannot create through the normal onboard path because current
  // blueprints reject versions below min_openclaw_version. Create that sandbox
  // through OpenShell, then upsert only this test-owned registry/session entry
  // so `nemoclaw <name> rebuild --yes` exercises the user-visible rebuild
  // boundary. Remove this local seeding once a first-class old-version lifecycle
  // fixture/profile exists.
  const registry = readJsonFile<{
    sandboxes?: Record<string, Record<string, unknown>>;
    defaultSandbox?: string;
  }>(REGISTRY_FILE, {});
  registry.sandboxes = registry.sandboxes ?? {};
  registry.sandboxes[SANDBOX_NAME] = {
    name: SANDBOX_NAME,
    createdAt: new Date().toISOString(),
    model: DEFAULT_MODEL,
    provider: "nvidia-prod",
    gpuEnabled: false,
    policies: [],
    policyTier: null,
    agent: null,
    agentVersion: OLD_OPENCLAW_VERSION,
  };
  registry.defaultSandbox = SANDBOX_NAME;
  writeJsonFile(REGISTRY_FILE, registry);

  const now = new Date().toISOString();
  const complete = { status: "complete", startedAt: now, completedAt: now, error: null };
  const pending = { status: "pending", startedAt: null, completedAt: null, error: null };
  const session = readJsonFile<Record<string, unknown>>(SESSION_FILE, {});
  Object.assign(session, {
    sandboxName: SANDBOX_NAME,
    status: "complete",
    resumable: true,
    lastCompletedStep: "inference",
    failure: null,
    provider: "nvidia-prod",
    model: DEFAULT_MODEL,
    credentialEnv: "NVIDIA_API_KEY",
    agent: null,
    steps: {
      preflight: complete,
      gateway: complete,
      sandbox: pending,
      provider_selection: complete,
      inference: complete,
      openclaw: pending,
      agent_setup: pending,
      policies: pending,
    },
  });
  writeJsonFile(SESSION_FILE, session);
}

function registrySandbox(): Record<string, unknown> {
  const data = readJsonFile<{ sandboxes?: Record<string, Record<string, unknown>> }>(
    REGISTRY_FILE,
    {},
  );
  const sandbox = data.sandboxes?.[SANDBOX_NAME];
  if (!sandbox) throw new Error(`registry entry missing for ${SANDBOX_NAME}`);
  return sandbox;
}

function latestRebuildBackupDir(): string {
  const sandboxBackupRoot = path.join(BACKUP_ROOT, SANDBOX_NAME);
  expect(fs.existsSync(sandboxBackupRoot), `backup root missing: ${sandboxBackupRoot}`).toBe(true);
  const latest = fs
    .readdirSync(sandboxBackupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  expect(latest, `no timestamped backup directory under ${sandboxBackupRoot}`).toBeTruthy();
  return path.join(sandboxBackupRoot, latest!);
}

function latestRebuildManifest(backupDir: string): Record<string, unknown> {
  const manifestPath = path.join(backupDir, "rebuild-manifest.json");
  expect(fs.existsSync(manifestPath), `backup manifest missing: ${manifestPath}`).toBe(true);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

function backupCredentialLeakPaths(backupDir: string, oldGatewayToken: string): string[] {
  const leaks: string[] = [];
  const skippedLockfiles = new Set([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
  ]);
  const candidatePattern = /(?:nvapi-|sk-|Bearer )/;

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = fs.readFileSync(fullPath, "utf8");
      if (text.includes(oldGatewayToken)) {
        leaks.push(fullPath);
        continue;
      }
      if (skippedLockfiles.has(entry.name)) continue;
      const isJsonOrEnv = /\.json$|\.env$|^\.env$/i.test(entry.name);
      if (isJsonOrEnv && candidatePattern.test(text)) {
        leaks.push(fullPath);
      }
    }
  }

  if (fs.existsSync(backupDir)) scan(backupDir);
  return leaks;
}

// Gate this live test on NEMOCLAW_RUN_E2E_SCENARIOS=1. Accidental cli-test-shard
// discovery must not build Docker images, mutate ~/.nemoclaw, or call NVIDIA.
test.skipIf(!shouldRunLiveE2EScenarios())(
  "rebuild-openclaw: old OpenClaw sandbox rebuild preserves state and rotates gateway token",
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "bin/nemoclaw.js missing — run npm ci && npm run build:cli before live rebuild coverage",
    ).toBe(true);

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: dockerContextEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for rebuild-openclaw live coverage:\n${resultText(dockerInfo)}`,
        );
      }
      skip("Docker is required for rebuild-openclaw live coverage");
    }

    await artifacts.writeJson("contract.json", {
      legacySource: "test/e2e/test-rebuild-openclaw.sh",
      oldOpenClawVersion: OLD_OPENCLAW_VERSION,
      sandboxName: SANDBOX_NAME,
      markerFile: MARKER_FILE,
      oldBaseTag: OLD_BASE_TAG,
      preservedBoundaries: [
        "docker build Dockerfile.base with old OPENCLAW_VERSION",
        "openshell sandbox create/exec/policy",
        "real nemoclaw onboard and rebuild CLI",
        "workspace marker, registry/session files, backup manifest, config hash",
      ],
    });

    // Pre-clean stale resources for the test-owned sandbox prefix before
    // registering final cleanup. The prefix guard above keeps a caller-selected
    // production/local sandbox name from being destroyed accidentally; snapshots
    // below still restore registry/session files after this generated-name run.
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy",
      env: cliEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 2 * 60_000,
    });
    await openshellBestEffort(
      host,
      ["sandbox", "delete", SANDBOX_NAME],
      "pre-cleanup-openshell-sandbox-delete",
    );
    await openshellBestEffort(
      host,
      ["gateway", "destroy", "-g", "nemoclaw"],
      "pre-cleanup-openshell-gateway-destroy",
    );
    await host.command("docker", ["rmi", OLD_BASE_TAG], {
      artifactName: "pre-cleanup-docker-rmi-old-base",
      env: dockerContextEnv(),
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    });

    const registrySnapshot = snapshotFile(REGISTRY_FILE);
    const sessionSnapshot = snapshotFile(SESSION_FILE);
    const sandboxBackupRoot = path.join(BACKUP_ROOT, SANDBOX_NAME);
    cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
      restoreFile(REGISTRY_FILE, registrySnapshot);
      restoreFile(SESSION_FILE, sessionSnapshot);
      fs.rmSync(sandboxBackupRoot, { recursive: true, force: true });
    });

    cleanup.add(`destroy rebuilt sandbox ${SANDBOX_NAME}`, async () => {
      await host.command(
        "node",
        [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"],
        {
          artifactName: "cleanup-nemoclaw-destroy",
          env: cliEnv(apiKey),
          redactionValues: [apiKey],
          timeoutMs: 2 * 60_000,
        },
      );
      await openshellBestEffort(
        host,
        ["sandbox", "delete", SANDBOX_NAME],
        "cleanup-openshell-sandbox-delete",
      );
      await openshellBestEffort(
        host,
        ["gateway", "destroy", "-g", "nemoclaw"],
        "cleanup-openshell-gateway-destroy",
      );
      await host.command("docker", ["rmi", OLD_BASE_TAG], {
        artifactName: "cleanup-docker-rmi-old-base",
        env: dockerContextEnv(),
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      });
    });

    // Phase 1: create a normal current sandbox first so the real gateway and
    // session/credential scaffolding exist, matching the legacy install/onboard
    // setup before it swaps in an old OpenClaw sandbox.
    const onboard = await host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
      artifactName: "phase-1-onboard-current",
      env: cliEnv(apiKey, { NEMOCLAW_RECREATE_SANDBOX: "1" }),
      redactionValues: [apiKey],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
    if (onboard.exitCode !== 0) {
      if (!isRetryableOnboardEndpointFailure(onboard)) {
        expectExitZero(onboard, "initial current onboard");
      }
      const gatewayProbe = await sandbox.list({
        artifactName: "phase-1-gateway-after-onboard-endpoint-transient",
        env: dockerContextEnv(),
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      });
      expectExitZero(gatewayProbe, "OpenShell gateway after tolerated onboard endpoint transient");
      await artifacts.writeJson("phase-1-onboard-transient-summary.json", {
        tolerated: true,
        reason: "retryable endpoint validation failure after gateway/provider setup",
      });
    }

    await openshellBestEffort(
      host,
      ["sandbox", "delete", SANDBOX_NAME],
      "phase-1-delete-current-sandbox",
    );

    // Phase 2: build the old base image with a temporary build context that
    // lowers only the blueprint minimum-version gate consumed by Dockerfile.base.
    // The trusted checkout stays read-only.
    const oldBaseBuildContext = createOldBaseBuildContext();
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
          oldBaseBuildContext,
        ],
        {
          artifactName: "phase-2-docker-build-old-openclaw-base",
          env: dockerContextEnv(),
          timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
        },
      );
      expectExitZero(buildOldBase, `docker build old OpenClaw ${OLD_OPENCLAW_VERSION}`);
    } finally {
      fs.rmSync(oldBaseBuildContext, { recursive: true, force: true });
    }

    // Phase 3: create an OpenShell sandbox from the old base image.
    const oldDockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-"));
    const oldDockerfile = path.join(oldDockerfileDir, "Dockerfile");
    fs.writeFileSync(
      oldDockerfile,
      [
        `FROM ${OLD_BASE_TAG}`,
        "USER sandbox",
        "WORKDIR /sandbox",
        "RUN mkdir -p /sandbox/.openclaw/workspace /sandbox/.openclaw && echo '{}' > /sandbox/.openclaw/openclaw.json",
        '["/bin/bash"]',
      ]
        .map((line, index) => (index === 4 ? `CMD ${line}` : line))
        .join("\n"),
      "utf8",
    );
    try {
      const createOldSandbox = await sandbox.openshell(
        [
          "sandbox",
          "create",
          "--name",
          SANDBOX_NAME,
          "--from",
          oldDockerfile,
          "--gateway",
          "nemoclaw",
          "--no-tty",
          "--",
          "true",
        ],
        {
          artifactName: "phase-3-create-old-openclaw-sandbox",
          env: dockerContextEnv(),
          timeoutMs: 10 * 60_000,
        },
      );
      expectExitZero(createOldSandbox, "openshell sandbox create old OpenClaw sandbox");
    } finally {
      fs.rmSync(oldDockerfileDir, { recursive: true, force: true });
    }
    await waitForSandboxReady(sandbox);

    const oldVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "phase-3-openclaw-old-version",
      env: dockerContextEnv(),
      timeoutMs: 30_000,
    });
    expectExitZero(oldVersion, "old openclaw --version");
    expect(resultText(oldVersion)).toContain(OLD_OPENCLAW_VERSION);

    // Phase 4: seed workspace state, an existing gateway token, and registry /
    // resume-session state so `nemoclaw <name> rebuild --yes` drives the same
    // user-visible rebuild path as the legacy script.
    const markerWrite = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-c",
        `mkdir -p /sandbox/.openclaw/workspace && printf '%s' '${MARKER_CONTENT}' > ${MARKER_FILE}`,
      ],
      {
        artifactName: "phase-4-write-workspace-marker",
        env: dockerContextEnv(),
        timeoutMs: 30_000,
      },
    );
    expectExitZero(markerWrite, "write workspace marker");

    const seedGateway = await sandbox.exec(
      SANDBOX_NAME,
      [
        "env",
        `PRE_REBUILD_GATEWAY_TOKEN=${PRE_REBUILD_GATEWAY_TOKEN}`,
        ...pythonExecArgs(`import json, os, subprocess
path='/sandbox/.openclaw/openclaw.json'
try:
    cfg=json.load(open(path))
except Exception:
    cfg={}
cfg.setdefault('gateway', {}).setdefault('auth', {})['token']=os.environ['PRE_REBUILD_GATEWAY_TOKEN']
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\\n')
subprocess.check_call(['bash','-lc','cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash'])
saved=json.load(open(path)).get('gateway',{}).get('auth',{}).get('token','')
hash_text=open('/sandbox/.openclaw/.config-hash').read()
print(json.dumps({'seeded': saved == os.environ['PRE_REBUILD_GATEWAY_TOKEN'], 'hashReferencesConfig': 'openclaw.json' in hash_text}))`),
      ],
      {
        artifactName: "phase-4-seed-gateway-token",
        env: dockerContextEnv(),
        redactionValues: [PRE_REBUILD_GATEWAY_TOKEN],
        timeoutMs: 30_000,
      },
    );
    expectExitZero(seedGateway, "seed old gateway token");
    const seedResult = JSON.parse(seedGateway.stdout.trim()) as SeedGatewayTokenResult;
    expect(seedResult).toEqual({ seeded: true, hashReferencesConfig: true });

    const preHashResult = await sandbox.exec(
      SANDBOX_NAME,
      ["cat", "/sandbox/.openclaw/.config-hash"],
      {
        artifactName: "phase-4-read-pre-rebuild-config-hash",
        env: dockerContextEnv(),
        timeoutMs: 30_000,
      },
    );
    expectExitZero(preHashResult, "read pre-rebuild config hash");
    const preRebuildConfigHash = preHashResult.stdout.trim();
    expect(preRebuildConfigHash).toContain("openclaw.json");

    seedRegistryAndSession();
    const sessionAfterSeed = readJsonFile<Record<string, unknown>>(SESSION_FILE, {});
    const seededSteps = sessionAfterSeed.steps as Record<string, { status?: string }> | undefined;
    const seededSandbox = registrySandbox();
    await artifacts.writeJson("phase-4-registry-session-summary.json", {
      registry: {
        name: seededSandbox.name,
        provider: seededSandbox.provider,
        agentVersion: seededSandbox.agentVersion,
        policyCount: Array.isArray(seededSandbox.policies) ? seededSandbox.policies.length : 0,
      },
      session: {
        sandboxName: sessionAfterSeed.sandboxName,
        status: sessionAfterSeed.status,
        provider: sessionAfterSeed.provider,
        model: sessionAfterSeed.model,
        stepStatuses: Object.fromEntries(
          Object.entries(seededSteps ?? {}).map(([step, value]) => [step, value.status]),
        ),
      },
    });

    const routeResult = await configureGatewayInferenceRoute(host, apiKey);
    expectExitZero(routeResult, "configure gateway inference route before rebuild");

    // Phase 4.5: apply policy presets through the public CLI, then verify both
    // registry persistence and the live OpenShell gateway policy.
    for (const preset of POLICY_PRESETS) {
      const policyAdd = await host.command(
        "node",
        [CLI_ENTRYPOINT, "sandbox", "policy", "add", SANDBOX_NAME, preset, "--yes"],
        {
          artifactName: `phase-4-policy-add-${preset}`,
          env: cliEnv(apiKey),
          redactionValues: [apiKey],
          timeoutMs: OPENSHELL_TIMEOUT_MS,
        },
      );
      expectExitZero(policyAdd, `policy add ${preset}`);
    }

    const prePolicy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-4-live-policy-before-rebuild",
      env: dockerContextEnv(),
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    });
    expectExitZero(prePolicy, "openshell policy get before rebuild");
    expect(prePolicy.stdout).toMatch(/npm|registry\.npmjs\.org/i);
    expect(prePolicy.stdout).toMatch(/pypi|pypi\.org/i);
    expect(prePolicy.stdout).toMatch(/telegram/i);
    expect(prePolicy.stdout).toContain("api.telegram.org");
    expect(registrySandbox().policies).toEqual(expect.arrayContaining([...POLICY_PRESETS]));
    const prePolicyList = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "policy-list"],
      {
        artifactName: "phase-4-nemoclaw-policy-list-before-rebuild",
        env: cliEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(prePolicyList, "nemoclaw policy-list before rebuild");
    expect(prePolicyList.stdout).toMatch(/●\s+telegram/i);

    // Phase 5: restore the current base image tag that rebuild consumes.
    const buildCurrentBase = await host.command(
      "docker",
      [
        "build",
        "-f",
        path.join(REPO_ROOT, "Dockerfile.base"),
        "-t",
        "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
        REPO_ROOT,
      ],
      {
        artifactName: "phase-5-docker-build-current-base",
        env: dockerContextEnv(),
        timeoutMs: DOCKER_BUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(buildCurrentBase, "docker build current base image");

    // Phase 6: run the real rebuild CLI.
    const rebuild = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "phase-6-nemoclaw-rebuild",
        env: cliEnv(apiKey, { NEMOCLAW_REBUILD_VERBOSE: "1" }),
        redactionValues: [apiKey, PRE_REBUILD_GATEWAY_TOKEN],
        timeoutMs: REBUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(rebuild, "nemoclaw rebuild");

    // Phase 7: state preservation, upgrade, token rotation, backup hygiene, and
    // policy-preset preservation assertions.
    const markerRead = await sandbox.exec(SANDBOX_NAME, ["cat", MARKER_FILE], {
      artifactName: "phase-7-read-workspace-marker",
      env: dockerContextEnv(),
      timeoutMs: 30_000,
    });
    expectExitZero(markerRead, "read workspace marker after rebuild");
    expect(markerRead.stdout).toBe(MARKER_CONTENT);

    const newVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "phase-7-openclaw-new-version",
      env: dockerContextEnv(),
      timeoutMs: 30_000,
    });
    expectExitZero(newVersion, "new openclaw --version");
    expect(resultText(newVersion)).not.toContain(OLD_OPENCLAW_VERSION);
    expect(resultText(newVersion).trim()).not.toBe("");

    const registryVersion = registrySandbox().agentVersion;
    expect(registryVersion).not.toBe(OLD_OPENCLAW_VERSION);
    expect(registryVersion).toEqual(expect.any(String));

    const tokenCheck = await sandbox.exec(
      SANDBOX_NAME,
      [
        "env",
        `PRE_REBUILD_GATEWAY_TOKEN=${PRE_REBUILD_GATEWAY_TOKEN}`,
        `PRE_REBUILD_CONFIG_HASH=${preRebuildConfigHash}`,
        ...pythonExecArgs(`import json, os, subprocess
cfg=json.load(open('/sandbox/.openclaw/openclaw.json'))
token=cfg.get('gateway',{}).get('auth',{}).get('token','')
runtime=subprocess.check_output(['bash','-lc','. /tmp/nemoclaw-proxy-env.sh >/dev/null 2>&1 || exit 1; printf "%s" "\${OPENCLAW_GATEWAY_TOKEN:-}"'], text=True)
hash_text=open('/sandbox/.openclaw/.config-hash').read()
hash_ok=subprocess.call(['bash','-lc','cd /sandbox/.openclaw && sha256sum -c .config-hash --status']) == 0
old=os.environ['PRE_REBUILD_GATEWAY_TOKEN']
print(json.dumps({'tokenPresent': bool(token), 'tokenRotated': token != old, 'runtimeMatchesConfig': runtime == token, 'runtimeStillOld': runtime == old, 'hashReferencesConfig': 'openclaw.json' in hash_text, 'hashChanged': hash_text != os.environ['PRE_REBUILD_CONFIG_HASH'], 'hashValid': hash_ok}))`),
      ],
      {
        artifactName: "phase-7-gateway-token-rotation-check",
        env: dockerContextEnv(),
        redactionValues: [PRE_REBUILD_GATEWAY_TOKEN],
        timeoutMs: 30_000,
      },
    );
    expectExitZero(tokenCheck, "gateway token rotation check");
    const tokenResult = JSON.parse(tokenCheck.stdout.trim()) as GatewayTokenRotationResult;
    expect(tokenResult).toEqual({
      tokenPresent: true,
      tokenRotated: true,
      runtimeMatchesConfig: true,
      runtimeStillOld: false,
      hashReferencesConfig: true,
      hashChanged: true,
      hashValid: true,
    });

    const backupDir = latestRebuildBackupDir();
    const manifest = latestRebuildManifest(backupDir);
    await artifacts.writeJson("phase-7-rebuild-manifest-summary.json", {
      backupDir,
      stateDirCount: Array.isArray(manifest.stateDirs) ? manifest.stateDirs.length : undefined,
      policyPresets: manifest.policyPresets,
      telegramBridgeTraffic:
        "real bot response remains owned by test/e2e/test-messaging-providers.sh M19b/future Phase 6 messaging-provider Vitest migration; this rebuild migration asserts restored telegram policy and api.telegram.org reachability",
    });
    expect(manifest.policyPresets).toEqual(expect.arrayContaining([...POLICY_PRESETS]));
    expect(backupCredentialLeakPaths(backupDir, PRE_REBUILD_GATEWAY_TOKEN)).toEqual([]);

    expect(registrySandbox().policies).toEqual(expect.arrayContaining([...POLICY_PRESETS]));
    const postPolicy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-7-live-policy-after-rebuild",
      env: dockerContextEnv(),
      timeoutMs: OPENSHELL_TIMEOUT_MS,
    });
    expectExitZero(postPolicy, "openshell policy get after rebuild");
    expect(postPolicy.stdout).toMatch(/npm|registry\.npmjs\.org/i);
    expect(postPolicy.stdout).toMatch(/pypi|pypi\.org/i);
    expect(postPolicy.stdout).toMatch(/telegram/i);
    expect(postPolicy.stdout).toContain("api.telegram.org");

    const postPolicyList = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "policy-list"],
      {
        artifactName: "phase-7-nemoclaw-policy-list-after-rebuild",
        env: cliEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: OPENSHELL_TIMEOUT_MS,
      },
    );
    expectExitZero(postPolicyList, "nemoclaw policy-list after rebuild");
    expect(postPolicyList.stdout).toMatch(/●\s+telegram/i);

    // #1952's real bot-response clause is owned by the messaging provider E2E
    // (`test/e2e/test-messaging-providers.sh` M19b, then the Phase 6 Vitest
    // migration). This rebuild/state migration keeps the deterministic
    // prerequisite: Telegram policy is restored and the gateway does not block
    // api.telegram.org after rebuild.
    const telegramApiReachability = await sandbox.exec(
      SANDBOX_NAME,
      [
        "node",
        "-e",
        "fetch('https://api.telegram.org/bot000000000:invalid/getMe', { signal: AbortSignal.timeout(15000) }).then((r) => console.log('STATUS_' + r.status)).catch((e) => { console.log('ERROR_' + (e.cause?.code || e.code || e.message)); process.exitCode = 1; })",
      ],
      {
        artifactName: "phase-7-telegram-api-reachability-after-rebuild",
        env: dockerContextEnv(),
        timeoutMs: 30_000,
      },
    );
    expectExitZero(telegramApiReachability, "api.telegram.org reachability after rebuild");
    expect(telegramApiReachability.stdout).toMatch(/STATUS_\d+/);
    expect(telegramApiReachability.stdout).not.toMatch(/STATUS_403|Forbidden/i);

    // External inference API availability can make this inconclusive; keep it as a
    // non-fatal artifact-producing probe like the legacy script did.
    await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-s",
        "--max-time",
        "60",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":100}',
      ],
      {
        artifactName: "phase-7-inference-after-rebuild-nonfatal",
        env: dockerContextEnv(),
        timeoutMs: 75_000,
      },
    );
  },
  REBUILD_TIMEOUT_MS + 2 * DOCKER_BUILD_TIMEOUT_MS + ONBOARD_TIMEOUT_MS,
);
