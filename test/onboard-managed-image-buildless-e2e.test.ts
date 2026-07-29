// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect } from "vitest";

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORM,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../src/lib/onboard/managed-image/contract";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
} from "../src/lib/onboard/managed-startup/profile";
import { test } from "./e2e/fixtures/workflow-e2e-test.ts";
import {
  nodeOptionsWithoutSourceLoader,
  SOURCE_REQUIRE_HOOK,
} from "./helpers/source-loader-options";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MODEL = "nvidia/test-managed-model";
const PROVIDER = "nvidia-prod";
const SOURCE_REVISION = "2f03907c3a7ec151d7f5d4bb2a73abafc2849f83";
const CATALOG_RELEASE = "v0.0.97";
const SECRET_CANARY = "managed-onboard-secret-canary-must-not-cross";
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

const E2E_PHASES = [
  "prepare the complete managed image catalog",
  "exercise OpenClaw buildless onboarding",
  "exercise Hermes buildless onboarding",
  "exercise Deep Agents Code buildless onboarding",
  "verify all-agent immutable launch evidence",
  "release managed onboarding fixtures",
] as const;

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
  registerCalls: Array<{
    agent?: string;
    imageTag?: string | null;
    name?: string;
    workload?: {
      schemaVersion?: number;
      kind?: string;
      reference?: string;
      release?: string;
      sourceRevision?: string;
      capabilityContractVersion?: number;
      startupProfileContractVersion?: number;
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
): string {
  const source = (relativePath: string) => JSON.stringify(path.join(REPO_ROOT, relativePath));
  return String.raw`
const { EventEmitter } = require("node:events");
const path = require("node:path");

const agentName = ${JSON.stringify(agent)};
const sandboxName = ${JSON.stringify(sandboxName)};
const catalogTemplate = ${JSON.stringify(catalog)};
const model = ${JSON.stringify(MODEL)};
const provider = ${JSON.stringify(PROVIDER)};
const catalogCalls = [];
const forbiddenCalls = [];
const registerCalls = [];
const runnerCommands = [];
const spawnCalls = [];

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

const catalogResolver = require(${source("src/lib/onboard/managed-image/catalog.ts")});
replace(catalogResolver, "resolveManagedImageCatalogFromGhcr", async ({ release }) => {
  const catalog = Object.fromEntries(
    Object.entries(catalogTemplate).map(([name, contract]) => [
      name,
      { ...contract, source: { ...contract.source, release } },
    ]),
  );
  catalogCalls.push({
    release,
    references: Object.fromEntries(
      Object.entries(catalog).map(([name, contract]) => [name, contract.reference]),
    ),
  });
  return catalog;
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

const runner = require(${source("src/lib/runner.ts")});
runner.run = (command, options = {}) => {
  const normalized = normalize(command);
  runnerCommands.push(normalized);
  if (/(?:^|\s)docker(?:\s+buildx)?\s+build(?:\s|$)/u.test(normalized)) {
    return poison("docker build");
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runFile = (file, args = []) => runner.run([file, ...args]);
runner.runCapture = (command) => {
  const normalized = normalize(command);
  runnerCommands.push(normalized);
  if (normalized.includes("sandbox get " + sandboxName)) return "";
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
registry.getSandbox = () => null;
registry.getDefault = () => null;
registry.listExtraProviders = () => [];
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${source("src/lib/onboard/preflight.ts")});
preflight.checkPortAvailable = async () => ({ ok: true });
const credentials = require(${source("src/lib/credentials/store.ts")});
credentials.prompt = async () => "";

const childProcess = require("node:child_process");
childProcess.spawn = (command, args = [], options = {}) => {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const normalized = normalize([command, ...argv]);
  if (/(?:^|\s)docker(?:\s+buildx)?\s+build(?:\s|$)/u.test(normalized)) {
    return poison("docker build");
  }
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
): { dockerCommands: string[]; payload: ChildPayload } {
  const fixture = path.join(root, agent);
  const fakeBin = path.join(fixture, "bin");
  const home = path.join(fixture, "home");
  const script = path.join(fixture, "managed-onboard.cjs");
  const dockerLog = path.join(fixture, "docker.log");
  const sandboxName = `managed-${agent.replaceAll(/[^a-z0-9]/gu, "-")}`;
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeRuntimeStubs(fakeBin, dockerLog);
  fs.writeFileSync(script, childSource(agent, sandboxName, catalog));

  const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: {
      HOME: home,
      NEMOCLAW_HOME: path.join(home, ".nemoclaw"),
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_TEST_SECRET_CANARY: SECRET_CANARY,
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
): void {
  const expectedContract = contractFor(agent);
  expect(result.payload.agent).toBe(agent);
  expect(result.payload.forbiddenCalls).toEqual([]);
  expect(result.payload.catalogCalls).toHaveLength(1);
  expect(result.payload.catalogCalls[0]?.release).toMatch(/^v[0-9]/u);
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

  const profileArguments = createArgs.filter((arg) =>
    arg.startsWith("NEMOCLAW_STARTUP_PROFILE_B64="),
  );
  expect(profileArguments).toHaveLength(1);
  const encodedProfile = profileArguments[0]?.slice("NEMOCLAW_STARTUP_PROFILE_B64=".length) ?? "";
  const profile = decodeManagedStartupProfile(encodedProfile);
  expect(encodeManagedStartupProfile(profile)).toBe(encodedProfile);
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
  expect(createArgs.filter((arg) => arg.startsWith("NEMOCLAW_CORPORATE_CA_B64="))).toEqual([]);
  expect(JSON.stringify(profile)).not.toContain(SECRET_CANARY);
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
        ? expect.stringContaining(`${name}=${value},localhost,`)
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
  expect(registration?.agent ?? "openclaw").toBe(agent);
  expect(registration?.workload).toEqual({
    schemaVersion: 1,
    kind: "managed-image",
    reference: expectedContract.reference,
    release: result.payload.catalogCalls[0]?.release,
    sourceRevision: SOURCE_REVISION,
    sourceCohort: expectedContract.source.cohort,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
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

describe("managed image buildless onboarding", () => {
  test("launches every shipped agent by immutable image and startup profile without Dockerfile work (#7744)", {
    timeout: 180_000,
    meta: { e2ePhases: E2E_PHASES },
  }, ({ progress }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-onboard-e2e-"));
    const catalog = completeCatalog();
    expect(Object.keys(catalog).sort()).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS].sort());

    try {
      progress.phase("exercise OpenClaw buildless onboarding");
      const openclaw = runManagedOnboard(root, "openclaw", catalog);

      progress.phase("exercise Hermes buildless onboarding");
      const hermes = runManagedOnboard(root, "hermes", catalog);

      progress.phase("exercise Deep Agents Code buildless onboarding");
      const dcode = runManagedOnboard(root, "langchain-deepagents-code", catalog);

      progress.phase("verify all-agent immutable launch evidence");
      assertManagedLaunch(openclaw, "openclaw");
      assertManagedLaunch(hermes, "hermes");
      assertManagedLaunch(dcode, "langchain-deepagents-code");

      progress.phase("release managed onboarding fixtures");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
