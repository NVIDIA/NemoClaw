// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
} from "../../src/lib/onboard/managed-startup/profile";
import { nodeOptionsWithoutSourceLoader, SOURCE_REQUIRE_HOOK } from "./source-loader-options";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MANAGED_IMAGE_PLATFORM = "linux/amd64" as const;
const MODEL = "nvidia/test-managed-model";
const PROVIDER = "nvidia-prod";
const SOURCE_REVISION = "2f03907c3a7ec151d7f5d4bb2a73abafc2849f83";
const CATALOG_RELEASE = "v0.0.97";
const AUTHENTICATED_PROXY_ENVIRONMENT = {
  HTTP_PROXY: "http://upper-http:upper-secret@upper-http.example.test:18080",
  HTTPS_PROXY: "http://upper-https:upper-secret@upper-https.example.test:18443",
  NO_PROXY: "upper.internal",
  http_proxy: "http://lower-http:lower-secret@lower-http.example.test:28080",
  https_proxy: "http://lower-https:lower-secret@lower-https.example.test:28443",
  no_proxy: "lower.internal",
} as const;
const DIGESTS = {
  openclaw: `sha256:${"1".repeat(64)}`,
  hermes: `sha256:${"2".repeat(64)}`,
  "langchain-deepagents-code": `sha256:${"3".repeat(64)}`,
} as const satisfies Record<ShippedManagedImageAgent, `sha256:${string}`>;

interface CatalogCall {
  release: string;
  references: Record<ShippedManagedImageAgent, string>;
}

interface SpawnCall {
  command: string;
  args: string[];
}

interface ChildPayload {
  agent: ShippedManagedImageAgent;
  catalogCalls: CatalogCall[];
  forbiddenCalls: string[];
  managedBootstrapCalls: Array<{
    operation: string;
    agent?: string;
    encodedProfile?: string;
    manifestDigest?: string;
    profileFingerprint?: string;
    repository?: string;
    schemaVersion?: number;
    sandboxName?: string;
  }>;
  registerCalls: Array<{
    agent?: string | null;
    dashboardPort?: number | null;
    imageTag?: string | null;
    name?: string;
    workload?: {
      schemaVersion?: number;
      kind?: string;
      reference?: string;
      platform?: string;
      release?: string;
      sourceRevision?: string;
      sourceCohort?: string;
      capabilityContractVersion?: number;
      startupProfileContractVersion?: number;
      encodedProfile?: string;
      startupProfileSha256?: string;
      credentialProxyReplayRequired?: boolean;
      shared?: boolean;
    };
  }>;
  runnerCommands: string[];
  spawnCalls: SpawnCall[];
}

function contractFor(agent: ShippedManagedImageAgent): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = DIGESTS[agent];
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: SOURCE_REVISION,
      release: CATALOG_RELEASE,
      cohort: "ghrun-7744-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function completeCatalog(): ManagedImageContractCatalog {
  return Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [agent, contractFor(agent)]),
  );
}

function childSource(
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  catalog: ManagedImageContractCatalog,
  recreate: boolean,
): string {
  const source = (relativePath: string) => JSON.stringify(path.join(REPO_ROOT, relativePath));
  return String.raw`
const { EventEmitter } = require("node:events");
const { createHash: createChildHash } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");

const agentName = ${JSON.stringify(agent)};
const sandboxName = ${JSON.stringify(sandboxName)};
const recreate = ${JSON.stringify(recreate)};
const catalogTemplate = ${JSON.stringify(catalog)};
const catalogRelease = ${JSON.stringify(CATALOG_RELEASE)};
const model = ${JSON.stringify(MODEL)};
const provider = ${JSON.stringify(PROVIDER)};
const catalogCalls = [];
const forbiddenCalls = [];
const managedBootstrapCalls = [];
const registerCalls = [];
const runnerCommands = [];
const spawnCalls = [];
let sandboxCreated = recreate;
let existingEntryAvailable = recreate;
let registeredSandbox = null;
let managedHermesVolume = recreate ? {
  Name: "nemoclaw-hermes-state-v1-" + sandboxName,
  Labels: {
    "io.nvidia.nemoclaw.hermes-state.managed": "true",
    "io.nvidia.nemoclaw.hermes-state.schema": "1",
    "io.nvidia.nemoclaw.hermes-state.sandbox": sandboxName,
    "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
  },
} : null;

// The protected live-E2E job intentionally runs source without build:cli.
// Route the root CLI's generated shared-boundary import back to its canonical
// .cts source so this test cannot pass only because a local dist tree exists.
const canonicalSandboxNameSource =
  ${source("nemoclaw/src/shared/sandbox-name.cts")};
const generatedSandboxName =
  ${source("nemoclaw/dist/shared/sandbox-name.cjs")};
const resolveFilename = Module._resolveFilename;
Module._extensions[".cts"] = Module._extensions[".ts"];
Module._resolveFilename = function(request, parent, isMain, options) {
  const requestedPath =
    request.startsWith(".") && parent && parent.filename
      ? path.resolve(path.dirname(parent.filename), request)
      : request;
  if (requestedPath === generatedSandboxName) return canonicalSandboxNameSource;
  return resolveFilename.call(this, request, parent, isMain, options);
};

const normalize = (command) =>
  (Array.isArray(command) ? command.map(String).join(" ") : String(command)).replace(/'/g, "");
const poison = (name) => {
  forbiddenCalls.push(name);
  throw new Error("managed onboarding entered forbidden legacy path: " + name);
};
const replace = (target, name, value) => {
  target[name] = value;
  if (target[name] !== value) throw new Error("could not install test boundary for " + name);
};
const childProcess = require("node:child_process");
require(${source("test/helpers/onboard-script-mocks.cjs")})
  .mockStandaloneGatewayTeardownAuthority();

const coreVersion = require(${source("src/lib/core/version.ts")});
replace(coreVersion, "getVersion", () => catalogRelease);
const catalogResolver = require(${source("src/lib/onboard/managed-image/catalog.ts")});
replace(catalogResolver, "resolveManagedImageCatalogFromGhcr", async ({ release }) => {
  catalogCalls.push({
    release,
    references: Object.fromEntries(
      Object.entries(catalogTemplate).map(([name, contract]) => [name, contract.reference]),
    ),
  });
  return catalogTemplate;
});
const workloadRuntime = require(${source("src/lib/onboard/workload/runtime.ts")});
const resolveRuntimeCapabilities = workloadRuntime.resolveSandboxWorkloadRuntimeCapabilities;
replace(workloadRuntime, "resolveSandboxWorkloadRuntimeCapabilities", (plan, profiles) =>
  resolveRuntimeCapabilities(plan, profiles, "x64"),
);
const agentOnboard = require(${source("src/lib/agent/onboard.ts")});
replace(agentOnboard, "createAgentSandbox", () => poison("agentOnboard.createAgentSandbox"));
const buildContextStage = require(${source("src/lib/onboard/build-context-stage.ts")});
replace(buildContextStage, "stageCreateSandboxBuildContext", () =>
  poison("stageCreateSandboxBuildContext"),
);
const sandboxBuildContext = require(${source("src/lib/sandbox/build-context.ts")});
replace(sandboxBuildContext, "stageOptimizedSandboxBuildContext", () =>
  poison("stageOptimizedSandboxBuildContext"),
);
const preparedBuild = require(${source("src/lib/onboard/prepared-dcode-rebuild.ts")});
replace(preparedBuild, "resolveSandboxBuildContext", () =>
  poison("resolveSandboxBuildContext"),
);
replace(preparedBuild, "resolveSandboxBuildPatch", () =>
  poison("resolveSandboxBuildPatch"),
);
const dockerfilePatch = require(${source("src/lib/onboard/sandbox-dockerfile-patch-flow.ts")});
replace(dockerfilePatch, "prepareSandboxDockerfilePatch", () =>
  poison("prepareSandboxDockerfilePatch"),
);
const sandboxPrebuild = require(${source("src/lib/onboard/sandbox-prebuild.ts")});
replace(sandboxPrebuild, "prebuildSandboxImageIfEligible", () =>
  poison("prebuildSandboxImageIfEligible"),
);
const baseImage = require(${source("src/lib/onboard/base-image.ts")});
replace(baseImage, "pullAndResolveBaseImageDigest", () =>
  poison("pullAndResolveBaseImageDigest"),
);
// Keep the compute plan on Docker so managed-image capability negotiation is
// real, while excluding the separate Docker-container restart compatibility
// shim. That shim is covered by its own suites and is not part of workload
// source selection or the sandbox-create transport asserted here.
const dockerDriverPlatform = require(${source("src/lib/onboard/docker-driver-platform.ts")});
replace(dockerDriverPlatform, "isLinuxDockerDriverGatewayEnabled", () => false);
const managedBootstrap = require(${source("src/lib/onboard/managed-bootstrap/docker.ts")});
const managedBootstrapContract = require(
  ${source("src/lib/onboard/managed-bootstrap/adapter.ts")},
);
const managedBootstrapAuthorityStore = require(
  ${source("src/lib/onboard/managed-bootstrap/docker-authority-store.ts")},
);
replace(managedBootstrapAuthorityStore, "createDockerManagedBootstrapAuthorityStore", () => ({
  async recordPreparedAuthority(authority) {
    managedBootstrapCalls.push({ operation: "authority" });
    return {
      schemaVersion: authority.schemaVersion,
      sandbox: authority.sandbox,
      bootstrapIdentity: authority.bootstrapIdentity,
      authorityFingerprint: authority.authorityFingerprint,
      recordId: "test-managed-onboard-authority",
      recordedAt: "2026-08-04T12:00:00.000Z",
    };
  },
}));
replace(managedBootstrap, "createDockerManagedBootstrapAdapter", () => {
  const runtimeId = "a".repeat(64);
  const replacementRuntimeId = "c".repeat(64);
  const runtimeImageContentId = "sha256:" + "b".repeat(64);
  const originalSpecCanonicalJson = '{"runtime":"original"}\n';
  const preparedSpecCanonicalJson = '{"runtime":"prepared"}\n';
  const replacementSpecCanonicalJson = '{"runtime":"replacement"}\n';
  const digest = (value) => createChildHash("sha256").update(value, "utf8").digest("hex");
  const originalSpecHash = digest(originalSpecCanonicalJson);
  const preparedSpecHash = digest(preparedSpecCanonicalJson);
  const replacementSpecHash = digest(replacementSpecCanonicalJson);
  return {
    async recoverUnfinishedTransactions() {
      return { receipts: [], failures: [] };
    },
    async createHeldWorkload(input) {
      const bootstrapIdentity = input.bootstrapIdentity;
      const heldWorkloadArgv = managedBootstrapContract.renderManagedBootstrapHeldCommand(
        input.request,
        bootstrapIdentity,
        input.plan.intendedWorkloadArgv,
      );
      managedBootstrapCalls.push({
        operation: "create",
        agent: input.request.agent,
        encodedProfile: input.request.encodedProfile,
        manifestDigest: input.plan.image.manifestDigest,
        profileFingerprint: input.request.profileFingerprint,
        repository: input.plan.image.repository,
        schemaVersion: input.request.schemaVersion,
        sandboxName: input.plan.sandboxName,
      });
      const createReceipt = await input.launch({ heldWorkloadArgv, bootstrapIdentity });
      return {
        schemaVersion: 1,
        sandbox: createReceipt.sandbox,
        bootstrapIdentity,
        heldWorkloadArgv,
        intendedWorkloadArgv: input.plan.intendedWorkloadArgv,
        plan: input.plan,
        createReceipt,
      };
    },
    async cleanupIncompleteCreate({ plan, bootstrapIdentity, createReceipt }) {
      return {
        schemaVersion: 1,
        sandbox: createReceipt.sandbox,
        bootstrapIdentity,
        outcome: "rolled-back",
        restoredRuntimeId: null,
        restoredSpecHash: null,
        heldWorkloadRemoved: true,
        alreadyRolledBack: false,
        finalizedAt: "2026-08-04T12:00:00.000Z",
      };
    },
    async discoverHeldWorkload(input) {
      managedBootstrapCalls.push({ operation: "discover" });
      return {
        sandbox: input.sandbox,
        runtimeId,
        bootstrapIdentity: input.bootstrapIdentity,
      };
    },
    async inspectHeldWorkload({ handle, discovered }) {
      managedBootstrapCalls.push({ operation: "inspect" });
      return {
        schemaVersion: 1,
        sandbox: handle.sandbox,
        runtimeId: discovered.runtimeId,
        bootstrapIdentity: handle.bootstrapIdentity,
        image: handle.plan.image,
        runtimeImageContentId,
        specHash: originalSpecHash,
        specCanonicalJson: originalSpecCanonicalJson,
        agentIdentity: handle.plan.agentIdentity,
        supervisorArgv: handle.plan.expectedSupervisorArgv,
        heldWorkloadArgv: handle.heldWorkloadArgv,
        metadata: handle.plan.metadata,
      };
    },
    async prepareBootstrapReplacement({ handle, snapshot, request }) {
      managedBootstrapCalls.push({ operation: "prepare" });
      return {
        schemaVersion: 1,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: snapshot.runtimeId,
        preparedRuntimeId: replacementRuntimeId,
        image: handle.plan.image,
        runtimeImageContentId,
        originalSpecHash,
        preparedSpecHash,
        preparedSpecCanonicalJson,
        expectedActivatedSpecHash: replacementSpecHash,
        expectedActivatedSpecCanonicalJson: replacementSpecCanonicalJson,
        profileFingerprint: request.profileFingerprint,
        rollbackAuthority: "test-managed-onboard-rollback-authority",
      };
    },
    async activateBootstrapReplacement({ handle, prepared }) {
      managedBootstrapCalls.push({ operation: "activate" });
      return {
        schemaVersion: 1,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: prepared.originalRuntimeId,
        replacementRuntimeId: prepared.preparedRuntimeId,
        image: prepared.image,
        runtimeImageContentId: prepared.runtimeImageContentId,
        originalSpecHash: prepared.originalSpecHash,
        replacementSpecHash,
        replacementSpecCanonicalJson,
        profileFingerprint: prepared.profileFingerprint,
      };
    },
    async awaitBootstrap({ handle, replacement }) {
      managedBootstrapCalls.push({ operation: "await" });
      return {
        schemaVersion: 1,
        sandbox: handle.sandbox,
        runtimeId: replacement.replacementRuntimeId,
        image: handle.plan.image,
        runtimeImageContentId,
        originalSpecHash,
        replacementSpecHash,
        profileFingerprint: handle.plan.profile.fingerprint,
        bootstrapIdentity: handle.bootstrapIdentity,
        transactionPending: true,
        completedAt: "2026-07-29T12:01:00.000Z",
      };
    },
    async finalizeBootstrap({ outcome, handle, snapshot }) {
      managedBootstrapCalls.push({ operation: outcome });
      return {
        schemaVersion: 1,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        outcome: outcome === "commit" ? "committed" : "rolled-back",
        restoredRuntimeId: outcome === "rollback" ? snapshot?.runtimeId ?? null : null,
        restoredSpecHash: outcome === "rollback" ? snapshot?.specHash ?? null : null,
        heldWorkloadRemoved: false,
        alreadyRolledBack: false,
        finalizedAt: "2026-07-29T12:02:00.000Z",
      };
    },
  };
});

const runner = require(${source("src/lib/runner.ts")});
runner.run = (command, options = {}) => {
  const argv = Array.isArray(command) ? command.map(String) : [];
  const normalized = normalize(command);
  runnerCommands.push(normalized);
  sandboxCreated = normalized.includes("sandbox delete") ? false : sandboxCreated;
  existingEntryAvailable = normalized.includes("sandbox delete") ? false : existingEntryAvailable;
  if (/(?:^|\s)docker(?:\s+buildx)?\s+build(?:\s|$)/u.test(normalized)) {
    return poison("docker build");
  }
  if (normalized.includes("sandbox get") && normalized.includes(sandboxName)) {
    return sandboxCreated
      ? { status: 0, stdout: "Name: " + sandboxName + "\nId: sbx-managed-fixture\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "sandbox not found" };
  }
  if (argv[0] === "docker" && argv[1] === "volume") {
    const volumeName = argv.at(-1);
    if (argv[2] === "inspect") {
      return managedHermesVolume
        ? { status: 0, stdout: JSON.stringify(managedHermesVolume) + "\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "Error response from daemon: no such volume" };
    }
    if (argv[2] === "create") {
      const labels = {};
      for (let index = 3; index < argv.length - 1; index += 1) {
        if (argv[index] !== "--label") continue;
        const [name, ...value] = argv[index + 1].split("=");
        labels[name] = value.join("=");
        index += 1;
      }
      managedHermesVolume = { Name: volumeName, Labels: labels };
      return { status: 0, stdout: volumeName + "\n", stderr: "" };
    }
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runFile = (file, args = []) => runner.run([file, ...args]);
runner.runCapture = (command) => {
  const normalized = normalize(command);
  runnerCommands.push(normalized);
  if (normalized.includes("sandbox get") && normalized.includes(sandboxName)) {
    return sandboxCreated
      ? "Name: " + sandboxName + "\nId: " + sandboxName + "-id\nState: Ready"
      : "";
  }
  if (normalized.includes("sandbox list")) return sandboxName + " Ready";
  if (normalized.includes("forward list")) {
    return sandboxName + " 127.0.0.1 18789 23189 running";
  }
  if (normalized.includes("dcode identity")) {
    const { getExpectedDcodeInferenceIdentity } =
      require(${source("src/lib/onboard/dcode-selection-drift.ts")});
    const identity = getExpectedDcodeInferenceIdentity(provider, model, "openai-completions");
    return [
      "Route: " + identity.route,
      "Provider: " + identity.provider,
      "Model: " + identity.model,
      "Endpoint: " + identity.endpoint,
    ].join("\n");
  }
  const mocked = require(${source("test/helpers/onboard-script-mocks.cjs")})
    .mockOnboardRunCapture(command);
  return mocked === null ? "" : mocked;
};
runner.runCaptureEx = (command) => ({
  status: 0,
  stdout: runner.runCapture(command),
  stderr: "",
});

const registry = require(${source("src/lib/state/registry.ts")});
const sourceEntry = recreate ? {
  name: sandboxName,
  agent: "hermes",
  gpuEnabled: false,
  openshellDriver: "docker",
  imageTag: catalogTemplate.hermes.reference,
  model,
  provider,
  toolDisclosure: "progressive",
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: catalogTemplate.hermes.reference,
    platform: "linux/amd64",
    release: catalogRelease,
    sourceRevision: catalogTemplate.hermes.source.revision,
    sourceCohort: catalogTemplate.hermes.source.cohort,
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: "existing-profile",
    startupProfileSha256: "0".repeat(64),
    credentialProxyReplayRequired: true,
    shared: true,
  },
} : null;
registry.getSandbox = () => registeredSandbox ?? (existingEntryAvailable ? sourceEntry : null);
registry.getDefault = () => null;
registry.listExtraProviders = () => [];
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  registeredSandbox = entry;
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${source("src/lib/onboard/preflight.ts")});
preflight.checkPortAvailable = async () => ({ ok: true });
const credentials = require(${source("src/lib/credentials/store.ts")});
credentials.prompt = async () => "";

childProcess.spawn = (command, args = [], options = {}) => {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const normalized = normalize([command, ...argv]);
  if (/(?:^|\s)docker(?:\s+buildx)?\s+build(?:\s|$)/u.test(normalized)) {
    return poison("docker build");
  }
  if (normalized.includes("sandbox create")) sandboxCreated = true;
  spawnCalls.push({ command: String(command), args: argv });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  child.unref = () => {};
  child.pid = 7744;
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: " + sandboxName + "\n"));
    child.emit("close", 0);
  });
  return child;
};

const { loadAgent } = require(${source("src/lib/agent/defs.ts")});
const { createSandbox } = require(${source("src/lib/onboard.ts")});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(
    null,
    model,
    provider,
    "openai-completions",
    sandboxName,
    null,
    [],
    null,
    loadAgent(agentName),
  );
  console.log(JSON.stringify({
    agent: agentName,
    catalogCalls,
    forbiddenCalls,
    managedBootstrapCalls,
    registerCalls,
    runnerCommands,
    spawnCalls,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
}

function writeRuntimeStubs(fakeBin: string, dockerLog: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "--version" ] || [ "${1:-}" = "-V" ]; then',
      '  printf "%s\\n" "openshell 0.0.96"',
      "fi",
      'if [ "${1:-}" = "sandbox" ] && [ "${2:-}" = "get" ]; then',
      '  printf "Sandbox:\\n\\n  Id: fixture-managed-sandbox\\n  Name: %s\\n  Phase: Ready\\n" "${!#}"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$NEMOCLAW_TEST_DOCKER_LOG"',
      'if [ "${1:-}" = "build" ] || { [ "${1:-}" = "buildx" ] && [ "${2:-}" = "build" ]; }; then',
      '  printf "%s\\n" "forbidden docker build" >&2',
      "  exit 97",
      "fi",
      'if [ "${1:-}" = "info" ]; then printf "%s\\n" "{}"; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(dockerLog, "");
}

function parsePayload(stdout: string): ChildPayload {
  const payload = stdout
    .trim()
    .split(/\r?\n/u)
    .reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  expect(payload, `managed onboard child did not emit evidence:\n${stdout}`).toBeDefined();
  return JSON.parse(payload as string) as ChildPayload;
}

function runManagedOnboard(
  root: string,
  agent: ShippedManagedImageAgent,
  catalog: ManagedImageContractCatalog,
  recreate = false,
): { dockerCommands: string[]; payload: ChildPayload } {
  const fixture = path.join(root, recreate ? `${agent}-recreate` : agent);
  const fakeBin = path.join(fixture, "bin");
  const home = path.join(fixture, "home");
  const script = path.join(fixture, "managed-onboard.cjs");
  const dockerLog = path.join(fixture, "docker.log");
  const sandboxName = agent === "langchain-deepagents-code" ? "managed-dcode" : `managed-${agent}`;
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRuntimeStubs(fakeBin, dockerLog);
  fs.writeFileSync(script, childSource(agent, sandboxName, catalog, recreate));

  const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: {
      HOME: home,
      NEMOCLAW_HOME: path.join(home, ".nemoclaw"),
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: recreate ? "1" : "0",
      NEMOCLAW_RECREATE_WITHOUT_BACKUP: recreate ? "1" : "0",
      NEMOCLAW_TEST_DOCKER_LOG: dockerLog,
      NEMOCLAW_TEST_NO_SLEEP: "1",
      NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      ...AUTHENTICATED_PROXY_ENVIRONMENT,
    },
  });
  expect(
    result.error,
    `${agent} managed onboard child failed to complete: ${result.error?.message}`,
  ).toBeUndefined();
  expect(
    result.signal,
    `${agent} managed onboard child was terminated:\n${result.stderr}\n${result.stdout}`,
  ).toBeNull();
  expect(
    result.status,
    `${agent} managed onboard child failed:\n${result.stderr}\n${result.stdout}`,
  ).toBe(0);

  const dockerCommands = fs.readFileSync(dockerLog, "utf8").trim().split(/\r?\n/u).filter(Boolean);
  return { dockerCommands, payload: parsePayload(result.stdout) };
}

function assertManagedLaunch(
  result: ReturnType<typeof runManagedOnboard>,
  agent: ShippedManagedImageAgent,
  expectedHermesVolumeCreate = true,
): void {
  const expectedContract = contractFor(agent);
  expect(result.payload.agent).toBe(agent);
  expect(result.payload.forbiddenCalls).toEqual([]);
  expect(result.payload.managedBootstrapCalls.map(({ operation }) => operation)).toEqual([
    "create",
    "discover",
    "inspect",
    "prepare",
    "authority",
    "activate",
    "await",
    "commit",
  ]);
  const bootstrapRequest = result.payload.managedBootstrapCalls[0];
  expect(bootstrapRequest).toMatchObject({
    agent,
    manifestDigest: expectedContract.digest,
    repository: expectedContract.image,
    schemaVersion: 1,
    sandboxName: expect.stringMatching(/^managed-/u),
    profileFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(result.payload.catalogCalls).toHaveLength(1);
  expect(result.payload.catalogCalls[0]?.release).toBe(CATALOG_RELEASE);
  expect(result.payload.catalogCalls[0]?.references).toEqual(
    Object.fromEntries(
      SHIPPED_MANAGED_IMAGE_AGENTS.map((catalogAgent) => [
        catalogAgent,
        contractFor(catalogAgent).reference,
      ]),
    ),
  );

  const createCalls = result.payload.spawnCalls.filter(
    ({ args }) => args[0] === "sandbox" && args[1] === "create",
  );
  expect(createCalls).toHaveLength(1);
  const createArgs = createCalls[0]?.args ?? [];
  expect(createArgs.filter((arg) => arg === "--from")).toHaveLength(1);
  const fromIndex = createArgs.indexOf("--from");
  expect(createArgs[fromIndex + 1]).toBe(expectedContract.reference);
  expect(createArgs.join(" ")).not.toContain("Dockerfile");
  if (agent === "hermes") {
    const driverConfigIndex = createArgs.indexOf("--driver-config-json");
    expect(driverConfigIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(createArgs[driverConfigIndex + 1]!) as unknown).toMatchObject({
      docker: {
        mounts: [
          {
            type: "volume",
            source: "nemoclaw-hermes-state-v1-managed-hermes",
            target: "/sandbox/.hermes",
            read_only: false,
          },
        ],
      },
    });
    expect(
      result.payload.runnerCommands.some((command) => command.startsWith("docker volume create ")),
    ).toBe(expectedHermesVolumeCreate);
  }

  expect(createArgs.filter((arg) => arg.startsWith("NEMOCLAW_STARTUP_PROFILE_B64="))).toEqual([]);
  const encodedProfile = bootstrapRequest?.encodedProfile;
  expect(encodedProfile).toEqual(expect.any(String));
  const requiredEncodedProfile = encodedProfile as string;
  const profile = decodeManagedStartupProfile(requiredEncodedProfile);
  expect(encodeManagedStartupProfile(profile)).toBe(requiredEncodedProfile);
  expect(profile).toMatchObject({
    schemaVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    agent,
    agentConfig: { agent },
    inference: {
      model: MODEL,
      upstreamProvider: PROVIDER,
    },
    dashboard: { agent },
  });
  if (agent === "langchain-deepagents-code") {
    expect(profile.dashboard).toEqual({ agent, mode: "disabled" });
    expect(createArgs.join("\n")).not.toContain("CHAT_UI_URL=");
    expect(createArgs.join("\n")).not.toContain("NEMOCLAW_DASHBOARD_PORT=");
    expect(
      result.payload.runnerCommands.every((command) => !command.includes("forward start")),
    ).toBe(true);
    expect(result.payload.runnerCommands.every((command) => !command.includes("/health"))).toBe(
      true,
    );
    const sandboxExecCommands = result.payload.runnerCommands.filter((command) =>
      command.includes("sandbox exec --name"),
    );
    expect(sandboxExecCommands).toHaveLength(1);
    expect(sandboxExecCommands[0]).toContain(
      `sandbox exec --name ${bootstrapRequest?.sandboxName} --gateway nemoclaw -- /usr/local/bin/dcode identity`,
    );
  } else {
    expect(
      result.payload.runnerCommands.some((command) =>
        command.includes(`sandbox get ${bootstrapRequest?.sandboxName}`),
      ),
    ).toBe(true);
    expect(
      result.payload.runnerCommands.some((command) =>
        command.includes(`sandbox exec --name ${bootstrapRequest?.sandboxName} -- true`),
      ),
    ).toBe(true);
  }
  expect(createArgs.filter((arg) => arg.startsWith("NEMOCLAW_CORPORATE_CA_B64="))).toEqual([]);
  expect(profile.proxy).toMatchObject({
    hostHttpUrl: null,
    hostHttpsUrl: null,
    hostNoProxy: [],
  });

  const serializedCreate = createArgs.join("\n");
  expect(serializedCreate.includes("upper-secret")).toBe(agent !== "langchain-deepagents-code");
  expect(serializedCreate.includes("lower-secret")).toBe(agent !== "langchain-deepagents-code");
  const expectedForwardedProxyEntries =
    agent === "langchain-deepagents-code" ? [] : Object.entries(AUTHENTICATED_PROXY_ENVIRONMENT);
  for (const [name, value] of expectedForwardedProxyEntries) {
    const forwarded = createArgs.find((argument) => argument.startsWith(`${name}=`));
    const expected =
      name === "NO_PROXY" || name === "no_proxy"
        ? expect.stringContaining(value)
        : `${name}=${value}`;
    expect(forwarded).toEqual(expected);
  }

  const registration = result.payload.registerCalls.find(
    (entry) =>
      entry.imageTag === expectedContract.reference && entry.name?.startsWith("managed-") === true,
  );
  expect(
    registration,
    `${agent} registration did not retain the managed image: ${JSON.stringify(
      result.payload.registerCalls,
    )}`,
  ).toBeDefined();
  expect(registration?.agent).toBe(agent);
  if (agent === "langchain-deepagents-code") {
    expect(registration?.dashboardPort).toBe(0);
  }
  expect(registration?.workload).toEqual({
    schemaVersion: 1,
    kind: "managed-image",
    reference: expectedContract.reference,
    platform: expectedContract.platform,
    release: CATALOG_RELEASE,
    sourceRevision: SOURCE_REVISION,
    sourceCohort: expectedContract.source.cohort,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile: requiredEncodedProfile,
    startupProfileSha256: createHash("sha256").update(requiredEncodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: agent !== "langchain-deepagents-code",
    shared: true,
  });
  const serializedReceipt = JSON.stringify(registration?.workload);
  expect(serializedReceipt).not.toContain("upper-secret");
  expect(serializedReceipt).not.toContain("lower-secret");
  expect(
    result.payload.runnerCommands.some((command) =>
      /(?:^|\s)docker(?:\s+buildx)?\s+build(?:\s|$)/u.test(command),
    ),
  ).toBe(false);
  expect(
    result.dockerCommands.some((command) => /^(?:build|buildx build)(?:\s|$)/u.test(command)),
  ).toBe(false);
}

export function runManagedImageBuildlessE2e(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-onboard-e2e-"));
  const catalog = completeCatalog();
  expect(Object.keys(catalog).sort()).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS].sort());

  try {
    const openclaw = runManagedOnboard(root, "openclaw", catalog);

    const hermes = runManagedOnboard(root, "hermes", catalog);

    const recreatedHermes = runManagedOnboard(root, "hermes", catalog, true);

    const dcode = runManagedOnboard(root, "langchain-deepagents-code", catalog);

    assertManagedLaunch(openclaw, "openclaw");
    assertManagedLaunch(hermes, "hermes");
    assertManagedLaunch(recreatedHermes, "hermes", false);
    assertManagedLaunch(dcode, "langchain-deepagents-code");
    const recreateDeleteIndex = recreatedHermes.payload.runnerCommands.findIndex((command) =>
      command.includes("sandbox delete"),
    );
    const volumeInspectIndex = recreatedHermes.payload.runnerCommands.findIndex((command) =>
      command.startsWith("docker volume inspect "),
    );
    const recreateCreateIndex = recreatedHermes.payload.spawnCalls.findIndex(
      ({ args }) => args[0] === "sandbox" && args[1] === "create",
    );
    expect(recreateDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(volumeInspectIndex).toBeGreaterThanOrEqual(0);
    expect(volumeInspectIndex).toBeLessThan(recreateDeleteIndex);
    expect(recreateCreateIndex).toBeGreaterThanOrEqual(0);
    expect(
      recreatedHermes.payload.runnerCommands.some((command) =>
        command.startsWith("docker volume rm "),
      ),
    ).toBe(false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}
