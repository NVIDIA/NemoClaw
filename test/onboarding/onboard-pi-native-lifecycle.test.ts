// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
  runOnboardProcessAsync,
} from "../helpers/onboard-child-process-harness";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../src/lib/onboard/managed-image/contract";
import { writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

function contractFor(agent: ManagedImageAgent, index: number): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${String(index + 1).repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: "d".repeat(40),
      release: "v0.1.0",
      cohort: "ghrun-7927-1",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

it("creates Pi native routing through public onboarding and preserves it on recovery (#12589)", async (context) => {
  const workspace = createOnboardProcessWorkspace("pi-native-onboard-");
  const catalog = workspace.path("catalog.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify(
      Object.fromEntries(
        SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contractFor(agent, index)]),
      ),
    ),
  );
  const root = path.join(import.meta.dirname, "../..");
  const hook = path.join(root, "test/helpers/onboard-script-mocks.cjs");
  const script = workspace.path("scenario.cjs");
  writeOkOpenshell(workspace.binDir);
  workspace.writeExecutable("brew", "#!/bin/sh\nexit 1\n");
  fs.writeFileSync(
    script,
    `
const assert = require("node:assert/strict");
const path = require("node:path");
const load = (name) => require(path.join(${JSON.stringify(root)}, "src/lib", name));
const policyCli = load("adapters/openshell/sandbox-policy-cli.ts");
let basePolicy = "version: 1\\n";
const capturePolicy = async (args) => {
  if (args[1] === "set") basePolicy = require("node:fs").readFileSync(args[args.indexOf("--policy") + 1], "utf8");
  const output = args.includes("json")
    ? JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture", active_version: 1, policy: require(path.join(${JSON.stringify(root)}, "node_modules/yaml")).parse(basePolicy) })
    : basePolicy;
  return { status: 0, stdout: output, output, stderr: "" };
};
const makeReader = policyCli.createCliOpenShellSandboxPolicyReader;
const makeWriter = policyCli.createCliOpenShellSandboxPolicyWriter;
Object.assign(policyCli.cliOpenShellSandboxPolicyReader, makeReader({ capture: capturePolicy }));
Object.assign(policyCli.cliOpenShellSandboxPolicyWriter, makeWriter({ capture: capturePolicy }));
const providers = new Map();
const created = [];
const updated = [];
let attached = [];
let recovering = false;
const adapter = {
  getProvider: async ({ providerName: name }) => providers.has(name)
    ? { ok: true, value: providers.get(name) }
    : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
  createProvider: async (input) => {
    created.push(input);
    providers.set(input.name, { name: input.name, type: input.type,
      credentialKeys: input.credentials.map((credential) => credential.name), configKeys: [],
      revision: { id: "native-openai-identity", resourceVersion: 1 } });
    return { ok: true };
  },
  updateProvider: async (input) => { updated.push(input); return { ok: true }; },
  listProviderAttachments: async () => ({ ok: true, value: { names: attached } }),
  importProviderProfile: async () => ({ ok: true }),
  ensureProviderPolicyComposition: async () => ({ ok: true, value: undefined }),
};
load("adapters/openshell/provider-adapter-cli.ts").createCliOpenShellProviderAdapter = () => adapter;
const fixtures = require(${JSON.stringify(hook)});
fixtures.mockStandaloneGatewayTeardownAuthority();
fixtures.mockManagedStateVolumeOnboardLifecycle();
load("core/version.ts").getVersion = () => "0.1.0";
const { advanceTo } = load("onboard/machine/result.ts");
load("onboard/machine/handlers/preflight.ts").handlePreflightState = async ({ session }) => ({
  gpu: null, sandboxGpuConfig: load("onboard/sandbox-gpu-mode.ts").resolveSandboxGpuConfig(null, { flag: "disable" }),
  resumePreflight: false, resumeHasResolvedGpuIntent: false, requestedGpuPassthrough: false,
  gpuPassthrough: false, effectiveSandboxGpuFlag: "disable", session,
  stateResult: advanceTo("gateway", { metadata: { state: "preflight" } }),
});
load("onboard/machine/handlers/gateway.ts").handleGatewayState = async ({ session }) => ({
  gatewayReuseState: "healthy", session, stateResult: advanceTo("provider_selection", { metadata: { state: "gateway" } }),
});
load("onboard/preflight.ts").checkPortAvailable = async () => ({ ok: true });
load("onboard/machine/preflight-gateway-authority.ts").createOnboardPreflightGatewayAuthority = () => ({
  collectGatewayReadiness: async () => ({}),
  prepareGatewayAuthority: async () => ({ externallySupervised: false, gatewayReuseState: "healthy" }),
});
const setup = load("onboard/setup-inference.ts");
const makeSetup = setup.createSetupInference;
let hostSmokeCalls = 0;
setup.createSetupInference = (deps, overrides) => makeSetup(deps, {
  ...overrides, providerAdapter: adapter,
  verifyOnboardInferenceSmoke: async () => { hostSmokeCalls += 1; },
});
const probes = load("inference/onboard-probes.ts");
probes.probeOpenAiLikeEndpointOptimized = async () => ({ ok: true });
probes.probeOpenAiLikeEndpoint = async () => ({ ok: true });
const runner = load("runner.ts");
const commands = [];
const sandbox = fixtures.createCreatedSandboxFixture({ sandboxName: "my-assistant", sandboxId: "pi-native-sandbox", gatewayName: "nemoclaw" });
runner.run = (command) => {
  commands.push(command);
  if (command.includes("gateway") && command.includes("list")) return { status: 0, stdout: "[]", stderr: "" };
  return sandbox.run(command) ?? { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const normalized = (Array.isArray(command) ? command.join(" ") : command).replace(/'/g, "");
  if (normalized.includes("gateway list")) return "[]";
  if (normalized.includes("gateway info")) return "Gateway endpoint: http://127.0.0.1:8080";
  if (normalized.includes("policy get")) return JSON.stringify({ scope: "sandbox", sandbox: "my-assistant", status: "effective", policy_source: "sandbox", hash: "fixture", active_version: 1, policy: {} });
  return sandbox.capture(command) ?? fixtures.mockOnboardRunCapture(command) ?? "";
};
const keepAlive = setInterval(() => {}, 1000);
let createChild;
const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => pid === -4242 ? createChild.kill(signal) : originalKill(pid, signal);
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args[0] === "policy") return originalSpawn(command, args, options);
  const invocation = [command, ...args];
  commands.push(invocation);
  const isCreate = args.includes("create");
  if (isCreate) {
    sandbox.create(invocation);
    attached = args.flatMap((arg, index) => arg === "--provider" ? [args[index + 1]] : []);
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = new (require("node:stream").Writable)({ write(_chunk, _encoding, callback) {
    callback();
  }});
  child.stdin.on("finish", () => child.emit("close", 0));
  child.stdout.destroy = child.stderr.destroy = child.unref = () => {};
  child.pid = 4242;
  if (isCreate) createChild = child;
  child.kill = () => { process.nextTick(() => child.emit("close", 0)); return true; };
  process.nextTick(() => {
    if (isCreate) child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\\n"));
    else if (args.some((arg) => arg.includes("NEMOCLAW_AGENT_BINARY_CHECK"))) {
      child.stdout.emit("data", Buffer.from("NEMOCLAW_AGENT_BINARY_CHECK:ok\\n"));
      child.emit("close", 0);
    } else if (args.includes("pi --version")) {
      child.stdout.emit("data", Buffer.from("NEMOCLAW_AGENT_SMOKE_BEGIN\\n" + (recovering ? "0.84.1" : "0.1.0") + "\\nNEMOCLAW_AGENT_SMOKE_EXIT:0\\n"));
      child.emit("close", 0);
    } else if (args.includes("test -s /sandbox/.pi/agent/models.json && echo NEMOCLAW_PI_MODELS_OK")) {
      child.stdout.emit("data", Buffer.from("NEMOCLAW_AGENT_SMOKE_BEGIN\\nNEMOCLAW_PI_MODELS_OK\\nNEMOCLAW_AGENT_SMOKE_EXIT:0\\n"));
      child.emit("close", 0);
    } else if (args.some((arg) => arg.endsWith("&& echo NEMOCLAW_PI_MODE_OK"))) {
      child.stdout.emit("data", Buffer.from("NEMOCLAW_AGENT_SMOKE_BEGIN\\nNEMOCLAW_PI_MODE_OK\\nNEMOCLAW_AGENT_SMOKE_EXIT:0\\n"));
      child.emit("close", 0);
    } else if (args.at(-1) === "true") child.emit("close", 0);
    else if (args.some((arg) => arg.includes("__NEMOCLAW_SANDBOX_EXEC_STARTED__") && arg.includes("/POLICY.md"))) {
      child.stdout.emit("data", Buffer.from("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\n")); child.emit("close", 0);
    } else if (!args.includes("-s")) throw new Error("Unexpected process fixture: " + args.join(" "));
  });
  return child;
};
const registry = load("state/registry.ts");
const { onboard } = load("onboard.ts");
(async () => {
  const options = { agent: "pi", sandboxName: "my-assistant", nonInteractive: true,
    tempManagedRuntime: true, tempManagedRuntimeCatalog: ${JSON.stringify(catalog)}, autoYes: true,
    acceptThirdPartySoftware: true, noGpu: true, deferProcessExit: true };
  // The runtime reports a wrong version after creation. Recovery must consume
  // the attachment and profile produced by onboarding, never a seeded entry.
  await assert.rejects(onboard(options), { name: "OnboardDeferredExitError" });
  const session = load("state/onboard-session.ts").loadSession();
  assert.equal(session.steps.sandbox.status, "complete");
  assert.equal(session.steps.agent_setup.status, "failed");
  const entry = registry.getSandbox("my-assistant");
  assert.equal(entry?.agent, "pi");
  assert.equal(entry?.nativeHostedProviderAttachment?.providerId, "native-openai-identity");
  assert.equal(entry.nativeHostedProviderAttachment.providerName, "nemoclaw-openai-api-v1");
  const { decodeManagedStartupProfile } = load("onboard/managed-startup/profile.ts");
  const { mapManagedStartupProfileToAgentEnvironment } = load("onboard/managed-startup/agent-environment.ts");
  const profile = decodeManagedStartupProfile(entry.workload.encodedProfile);
  assert.equal(profile.inference.routedBaseUrl, "https://api.openai.com/v1");
  assert.equal(mapManagedStartupProfileToAgentEnvironment(profile, {}).configurationEnvironment.NEMOCLAW_INFERENCE_BASE_URL, "https://api.openai.com/v1");
  assert.deepEqual(attached, ["nemoclaw-openai-api-v1"]);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  const updatesBeforeResume = updated.length;
  const nativeProvider = providers.get("nemoclaw-openai-api-v1");
  providers.set(nativeProvider.name, { ...nativeProvider, revision: { ...nativeProvider.revision, id: "replacement-provider" } });
  await assert.rejects(onboard({ ...options, resume: true }), /changed identity/);
  assert.deepEqual(registry.getSandbox("my-assistant").nativeHostedProviderAttachment, entry.nativeHostedProviderAttachment);
  providers.delete(nativeProvider.name);
  await assert.rejects(onboard({ ...options, resume: true }), /is missing/);
  assert.deepEqual(registry.getSandbox("my-assistant").nativeHostedProviderAttachment, entry.nativeHostedProviderAttachment);
  providers.set(nativeProvider.name, nativeProvider);
  recovering = true;
  await onboard({ ...options, resume: true });
  const recovered = registry.getSandbox("my-assistant");
  assert.deepEqual(recovered.nativeHostedProviderAttachment, entry.nativeHostedProviderAttachment);
  assert.equal(recovered.workload.encodedProfile, entry.workload.encodedProfile);
  assert.equal(load("state/onboard-session.ts").loadSession().status, "complete");
  assert.equal(created.length, 1);
  assert.equal(hostSmokeCalls, 1);
  assert.equal(updated.length, updatesBeforeResume);
  assert.equal(commands.filter((command) => command.includes("sandbox") && command.includes("create")).length, 1);
  assert.equal(commands.some((command) => command.includes("inference") && command.includes("set")), false);
  console.log("PI_NATIVE_ONBOARDED");
})().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
`,
  );
  try {
    const result = await runOnboardProcessAsync(["--require", hook, script], {
      context,
      timeoutMs: 12_000,
      env: minimalSpawnEnv(workspace.homeDir, {
        TMPDIR: workspace.root,
        NEMOCLAW_CORPORATE_CA_IMPORT: "0",
        OPENAI_API_KEY: "synthetic-pi-openai-key",
        NEMOCLAW_PROVIDER: "openai",
        NEMOCLAW_MODEL: "gpt-5.4",
        PATH: `${workspace.binDir}${path.delimiter}${process.env.PATH}`,
      }),
    });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("PI_NATIVE_ONBOARDED");
  } finally {
    workspace.remove();
  }
});
