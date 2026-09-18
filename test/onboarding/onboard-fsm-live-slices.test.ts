// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, it, type TestContext, vi } from "vitest";
import {
  type OnboardProcessResult,
  runOnboardProcessAsync,
} from "../helpers/onboard-child-process-harness";

const repoRoot = path.join(import.meta.dirname, "../..");
const probeTimeoutMs = 60_000;

vi.setConfig({ maxConcurrency: 4, testTimeout: probeTimeoutMs });

type SliceName = "initial" | "core" | "final";
type ProbeMode =
  | "fresh"
  | "endpoint-override"
  | "resume-initial"
  | "resume-core-gateway"
  | "resume-incomplete-core-gateway"
  | "resume-core-gateway-provenance-resolver"
  | "authoritative-core-gateway"
  | "authoritative-core-gateway-policy-tier"
  | "dashboard-port-composition"
  | "dashboard-spawn-failure"
  | "ordinary-policy-tier"
  | "providerless-external-component"
  | "providerless-staged-messaging"
  | "stale-recovery-admission"
  | "stale-session-decision"
  | "active-cancellation"
  | "ahead-core";

interface ProbeOptions {
  launchMarkerPath?: string;
  slice: SliceName;
  mode?: ProbeMode;
  policyTier?: "balanced" | "restricted";
  workspaceRoot?: string;
}

interface DistArtifact {
  label: string;
  sourcePath: string;
  distPath: string;
}

const requiredDistArtifacts: readonly DistArtifact[] = [
  {
    label: "onboard dispatcher",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard.ts"),
    distPath: path.join(repoRoot, "src", "lib", "onboard.ts"),
  },
  {
    label: "flow slices",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
    distPath: path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
  },
  {
    label: "state results",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
    distPath: path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
  },
  {
    label: "session persistence",
    sourcePath: path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    distPath: path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
  },
  {
    label: "preflight handler",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "preflight.ts"),
    distPath: path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "preflight.ts"),
  },
  {
    label: "provider inference handler",
    sourcePath: path.join(
      repoRoot,
      "src",
      "lib",
      "onboard",
      "machine",
      "handlers",
      "provider-inference.ts",
    ),
    distPath: path.join(
      repoRoot,
      "src",
      "lib",
      "onboard",
      "machine",
      "handlers",
      "provider-inference.ts",
    ),
  },
  {
    label: "gateway handler",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "gateway.ts"),
    distPath: path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "gateway.ts"),
  },
];

function distArtifactStatus(): { ok: true } | { ok: false; reason: string } {
  for (const artifact of requiredDistArtifacts) {
    if (!fs.existsSync(artifact.distPath)) {
      return {
        ok: false,
        reason: `${artifact.label} is missing at ${path.relative(repoRoot, artifact.distPath)}`,
      };
    }
    if (!fs.existsSync(artifact.sourcePath)) continue;
    const sourceMtime = fs.statSync(artifact.sourcePath).mtimeMs;
    const distMtime = fs.statSync(artifact.distPath).mtimeMs;
    if (sourceMtime > distMtime + 1000) {
      return {
        ok: false,
        reason: `${artifact.label} is older than ${path.relative(repoRoot, artifact.sourcePath)}`,
      };
    }
  }
  return { ok: true };
}

function assertFreshDistArtifacts(): void {
  const status = distArtifactStatus();
  if (status.ok) return;
  throw new Error(
    `Live onboard FSM slice boundary tests require fresh compiled CLI artifacts: ${status.reason}. Run npm run build:cli before this test.`,
  );
}

function writeSuccessfulOpenShell(tmpDir: string): string {
  const openshellPath = path.join(tmpDir, "openshell");
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "policy" && args[1] === "list" && args.includes("--global")) process.stderr.write("No global policy history found\\n");
if (args[0] === "-V" || args[0] === "--version") process.stdout.write("openshell 0.0.116\\n");
if (args[0] === "status") { process.stderr.write("No active gateway\\n"); process.exit(1); }
if (args[0] === "gateway" && args[1] === "info") { process.stderr.write("No gateway metadata found\\n"); process.exit(1); }
if (args[0] === "gateway" && args[1] === "list") process.stdout.write("[]\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );
  return openshellPath;
}

function probeEnvironment(tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: tmpDir,
    TMPDIR: tmpDir,
    PATH: process.env.PATH || "/usr/bin:/bin",
    NEMOCLAW_OPENSHELL_BIN: writeSuccessfulOpenShell(tmpDir),
    NODE_ENV: "test",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: "fsm-sandbox",
    NEMOCLAW_YES: "1",
    NO_COLOR: "1",
  };
  for (const key of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function redactProbeOutput(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|password|secret)=)[^\s]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^@\s]+@/gi, "$1<redacted>@")
    .slice(0, 4000);
}

function probeFailureMessage(result: OnboardProcessResult): string {
  const details = [
    `slice probe exited with status ${result.status ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}`,
    result.error ? `error: ${redactProbeOutput(result.error.message)}` : null,
    result.stderr ? `stderr:\n${redactProbeOutput(result.stderr)}` : null,
    result.stdout ? `stdout:\n${redactProbeOutput(result.stdout)}` : null,
  ].filter(Boolean);
  return details.join("\n\n");
}

async function runSliceProbe(
  options: ProbeOptions,
  context: Pick<TestContext, "signal" | "onTestFinished">,
) {
  const scenario = {
    launchMarkerPath: options.launchMarkerPath,
    mode: options.mode ?? "fresh",
    slice: options.slice,
  };
  const tmpDir = fs.mkdtempSync(
    path.join(
      options.workspaceRoot ?? os.tmpdir(),
      `nemoclaw-onboard-fsm-${scenario.mode}-${scenario.slice}-`,
    ),
  );
  try {
    const scriptPath = path.join(tmpDir, `probe-${scenario.mode}-${scenario.slice}.js`);
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const flowSlicesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
    );
    const resultPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
    );
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );
    const entryOptionsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "entry-options.ts"),
    );
    const lockedRuntimePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "resume", "locked-runtime.ts"),
    );
    const preflightHandlerPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "preflight.ts"),
    );
    const providerHandlerPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "provider-inference.ts"),
    );
    const gatewayHandlerPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "gateway.ts"),
    );
    const coreFlowPhasesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "core-flow-phases.ts"),
    );
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const onboardDashboardPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "dashboard.ts"),
    );
    const agentOnboardPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "agent", "onboard.ts"),
    );
    const agentSelectionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "agent-selection.ts"),
    );
    const dashboardUrlCommandPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "dashboard-url-command.ts"),
    );
    const finalizationDepsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "finalization-deps.ts"),
    );
    const externalComponentPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "external-component", "index.ts"),
    );
    const gatewayServicePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "docker-driver-gateway-service.ts"),
    );

    fs.writeFileSync(
      scriptPath,
      `
const scenario = ${JSON.stringify(scenario)};
scenario.launchMarkerPath && require("node:fs").writeFileSync(scenario.launchMarkerPath, "launched");
if (scenario.mode === "active-cancellation") {
  const activeCloseReadyPath = require("node:path").join(process.env.HOME, "active-close-hold.ready");
  const activeCloseReleasePath = require("node:path").join(process.env.HOME, "active-close-hold.release");
  const activeCloseHolder = require("node:child_process").spawn(
    process.execPath,
    [
      "-e",
      'const fs = require("node:fs"); const [readyPath, releasePath] = process.argv.slice(1); const parentPid = process.ppid; let orphanedAt = null; fs.writeFileSync(readyPath, String(process.pid)); const poll = setInterval(() => { if (fs.existsSync(releasePath)) { clearInterval(poll); process.exit(0); } if (process.ppid !== parentPid) { orphanedAt ??= Date.now(); if (Date.now() - orphanedAt >= 500) { clearInterval(poll); process.exit(0); } } }, 10);',
      activeCloseReadyPath,
      activeCloseReleasePath,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  activeCloseHolder.unref();
  require("node:fs").writeFileSync(
    require("node:path").join(process.env.HOME, "active-child.pid"),
    String(process.pid),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (scenario.mode === "dashboard-spawn-failure") {
  require(${gatewayServicePath}).hasOpenShellGatewayUserService = () => false;
}
const dashboardScenario = scenario.mode.startsWith("dashboard-");
// Slice dispatch uses fixture gateway bindings and must not observe host listeners.
require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"))})
  .checkPortAvailable = async () => ({ ok: true });
const gatewayReadiness = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "readiness", "gateway-production.ts"))});
const createGatewayReadiness = gatewayReadiness.createProductionGatewayReadinessDependencies;
gatewayReadiness.createProductionGatewayReadinessDependencies = (options) => ({
  ...createGatewayReadiness(options),
  observeManagedGateway: async () => ({
    reuseState: "missing",
    driftState: "not-detected",
    portConflictState: "none",
  }),
});
const flowSlices = require(${flowSlicesPath});
const { advanceTo, branchTo } = require(${resultPath});
const onboardSession = require(${sessionPath});
const onboardEntryOptions = require(${entryOptionsPath});
const lockedRuntime = require(${lockedRuntimePath});
const preflightHandlers = require(${preflightHandlerPath});
const providerHandlers = require(${providerHandlerPath});
const gatewayHandlers = require(${gatewayHandlerPath});
const coreFlowPhases = require(${coreFlowPhasesPath});
const registry = require(${registryPath});
const called = [];
const sentinel = new Error("slice-called");
const staleAdmissionExit = new Error("stale recovery admission refused");

if (scenario.mode === "providerless-external-component") {
  require(${externalComponentPath}).loadExternalComponentDeclaration = () => {
    called.push("component-validated");
    return {
      declaration: { schemaVersion: 1, componentId: "policy-governance", interceptorSocketPath: "/run/component/interceptor.sock", activationSocketPath: "/run/component/activation.sock" },
      revalidateBeforeGateway() {},
      revalidateBeforeActivation() {},
    };
  };
}

if (dashboardScenario) {
  const finalizationHandlerDeps = require(${finalizationDepsPath}).finalizationHandlerDeps;
  finalizationHandlerDeps.checkAndRecoverSandboxProcesses = async () => true;
  finalizationHandlerDeps.settleOrdinaryOpenClawPairing = async () => ({ kind: "settled" });
  const onboardDashboard = require(${onboardDashboardPath});
  const createOnboardDashboardHelpers = onboardDashboard.createOnboardDashboardHelpers;
  let dashboardForwardCalls = 0;
  onboardDashboard.createOnboardDashboardHelpers = (deps) => {
    if (scenario.mode === "dashboard-spawn-failure") {
      const { createCliOpenShellForwardAdapter } = require(${JSON.stringify(path.join(repoRoot, "src/lib/adapters/openshell/forward-cli.ts"))});
      return createOnboardDashboardHelpers({
        ...deps,
        getGatewayForwardRuntimeAuthority: () => ({
          gatewayEndpoint: "https://127.0.0.1:8080",
          gatewayName: "nemoclaw",
          workspace: "default",
        }),
        resolveForwardGatewayName: () => "nemoclaw",
        forwardAdapterForAuthority: (authority) => {
          const adapter = createCliOpenShellForwardAdapter({
            executable: ${JSON.stringify(path.join(tmpDir, "missing-openshell"))},
            gatewayEndpoint: authority.gatewayEndpoint,
            inspect: async () => ({ state: "unbound" }),
            probePort: async () => ({ state: "unbound" }),
            run: async () => ({ status: 0, stdout: "No active forwards.", stderr: "" }),
            runtimeSelection: authority,
          });
          return {
            ...adapter,
            observeForwards: async ({ forwards }) =>
              forwards.map((forward) => ({ state: "absent", forward })),
            startForward: (request) => {
            called.push("forward-launch");
              return adapter.startForward({ ...request, timeoutMs: 1000 });
            },
          };
        },
      });
    }
    const nextDashboardForward = () => {
      const port = dashboardForwardCalls === 0 ? 18791 : 18792;
      dashboardForwardCalls += 1;
      called.push("forward-port:" + String(port));
      return port;
    };
    return {
      ...createOnboardDashboardHelpers(deps),
      ensureAgentDashboardForward: nextDashboardForward,
      ensureFinalizationAgentDashboardForward: nextDashboardForward,
    };
  };
  require(${agentOnboardPath}).handleAgentSetup = async (
    _sandboxName,
    _model,
    _provider,
    _agent,
    _resume,
    _preparedSandbox,
    context,
  ) => {
    called.push("agent-executor:" + typeof context.sandboxCommandExecutor?.runBuffered);
  };
  require(${agentSelectionPath}).createOnboardAgentSelector = () => async () => ({
    name: "hermes",
    displayName: "Hermes Agent",
    ...(scenario.mode === "dashboard-spawn-failure"
      ? { dashboard: { kind: "api", port: 8642 } }
      : {}),
  });
}

if (scenario.mode.endsWith("policy-tier") || scenario.mode.endsWith("provenance-resolver")) {
  const readsProvenance = scenario.mode.endsWith("provenance-resolver");
  const factoryName = readsProvenance
    ? "createProviderInferenceOnboardFlowPhase"
    : "createSandboxOnboardFlowPhase";
  coreFlowPhases[factoryName] = (options) => {
    const detail = readsProvenance
      ? (() => {
          const entry = options.endpointProvenance.getSandboxRegistryEntry("fsm-sandbox");
          return ["registry-provenance", entry?.provider, entry?.endpointUrl, entry?.endpointSource].join(":");
        })()
      : "authoritative-policy-tier:" +
        (options.authoritativePolicyTier === undefined
          ? "undefined"
          : String(options.authoritativePolicyTier));
    called.push(detail);
    throw sentinel;
  };
}

function machine(state, revision = 1) {
  return { version: 1, state, stateEnteredAt: null, revision };
}

function seedResumeSession(state, sandboxComplete = true) {
  const session = onboardSession.createSession({
    mode: "non-interactive",
    sandboxName: "fsm-sandbox",
    provider: "openai-api",
    model: "gpt-test",
    machine: machine(state),
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  });
  for (const step of ["preflight", "gateway", "provider_selection"]) {
    session.steps[step].status = "complete";
  }
  if (sandboxComplete) session.steps.sandbox.status = "complete";
  session.checkpoint = require(${JSON.stringify(path.join(repoRoot, "src", "lib", "state", "onboard-checkpoint-migrate.ts"))})
    .deriveCheckpointFromSession(session, { profile: "default" });
  onboardSession.saveSession(session);
}

function baseContext(context, overrides = {}) {
  return {
    ...context,
    session: overrides.session ?? context.session ?? null,
    sandboxName: overrides.sandboxName ?? context.sandboxName ?? "fsm-sandbox",
    model: overrides.model ?? context.model ?? "model",
    provider: overrides.provider ?? context.provider ?? "provider",
    endpointUrl: overrides.endpointUrl ?? context.endpointUrl ?? null,
    credentialEnv: overrides.credentialEnv ?? context.credentialEnv ?? null,
    hermesAuthMethod: overrides.hermesAuthMethod ?? context.hermesAuthMethod ?? null,
    hermesToolGateways: overrides.hermesToolGateways ?? context.hermesToolGateways ?? [],
    preferredInferenceApi: overrides.preferredInferenceApi ?? context.preferredInferenceApi ?? null,
    nimContainer: overrides.nimContainer ?? context.nimContainer ?? null,
    webSearchConfig: overrides.webSearchConfig ?? context.webSearchConfig ?? null,
    webSearchSupported: overrides.webSearchSupported ?? context.webSearchSupported ?? false,
    selectedMessagingChannels: overrides.selectedMessagingChannels ?? context.selectedMessagingChannels ?? [],
    gpu: overrides.gpu ?? context.gpu ?? null,
    sandboxGpuConfig: overrides.sandboxGpuConfig ?? context.sandboxGpuConfig ?? { sandboxGpuEnabled: false, mode: "0" },
    gpuPassthrough: overrides.gpuPassthrough ?? context.gpuPassthrough ?? false,
    resumeHasResolvedGpuIntent: false,
    requestedGpuPassthrough: false,
  };
}

preflightHandlers.handlePreflightState = async (options) => {
  if (scenario.mode === "providerless-external-component") {
    called.push("preflight-effect");
    return {
      gpu: null,
      sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
      resumePreflight: false,
      resumeHasResolvedGpuIntent: false,
      requestedGpuPassthrough: false,
      gpuPassthrough: false,
      effectiveSandboxGpuFlag: "disable",
      effectiveSandboxGpuDevice: null,
      session: options.session,
      stateResult: advanceTo("gateway", { metadata: { state: "preflight" } }),
    };
  }
  if (scenario.mode.includes("core-gateway")) {
    return {
      gpu: null,
      sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
      resumePreflight: true,
      resumeHasResolvedGpuIntent: true,
      requestedGpuPassthrough: false,
      gpuPassthrough: false,
      effectiveSandboxGpuFlag: "disable",
      effectiveSandboxGpuDevice: null,
      session: options.session,
      stateResult: advanceTo("gateway", { metadata: { state: "preflight" } }),
    };
  }
  throw new Error("unexpected preflight compatibility handler");
};

gatewayHandlers.handleGatewayState = async (options) => {
  if (scenario.mode === "providerless-external-component") {
    called.push("gateway-effect");
    return { gatewayReuseState: "healthy", session: options.session, stateResult: advanceTo("provider_selection", { metadata: { state: "gateway" } }) };
  }
  if (!scenario.mode.includes("core-gateway")) {
    throw new Error("unexpected gateway compatibility handler");
  }
  called.push("gateway:" + options.gatewayName + ":" + process.env.OPENSHELL_GATEWAY);
  return {
    gatewayReuseState: "healthy",
    session: options.session,
    stateResult: advanceTo("provider_selection", { metadata: { state: "gateway" } }),
  };
};

providerHandlers.handleProviderInferenceState = async (options) => {
  if (scenario.mode !== "ahead-core" && !scenario.mode.includes("core-gateway")) {
    throw new Error("unexpected provider compatibility handler");
  }
  called.push(
    scenario.mode === "ahead-core" ? "provider-compat" : "provider-compat:" + options.gatewayName,
  );
  throw sentinel;
};

if (scenario.mode !== "providerless-external-component") {
  flowSlices.runInitialOnboardFlowSequence = async ({ context, runtime }) => {
    const initialSession = await runtime.session();
    called.push("initial:" + initialSession.machine.state);
    if (scenario.slice === "initial") throw sentinel;
    if (initialSession.machine?.state === "init") {
      await runtime.applyResult(advanceTo("preflight"));
    }
    await runtime.applyResult(advanceTo("gateway", { metadata: { state: "preflight" } }));
    await runtime.applyResult(advanceTo("provider_selection", { metadata: { state: "gateway" } }));
    if (scenario.mode === "ahead-core") {
      await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
    }
    const session = await runtime.session();
    return { context: baseContext(context, { session }), session };
  };
}

flowSlices.runCoreOnboardFlowSequence = async ({ context, runtime }) => {
  if (scenario.mode === "providerless-external-component") {
    called.push("sandbox-effect");
    throw sentinel;
  }
  called.push("core");
  if (scenario.mode === "ahead-core") {
    throw new Error("strict core runner should not run after an ahead-state handoff");
  }
  if (scenario.slice === "core") throw sentinel;
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", { metadata: { state: "inference" } }));
  await runtime.applyResult(
    branchTo(dashboardScenario ? "agent_setup" : "openclaw", {
      metadata: { state: "sandbox" },
    }),
  );
  const session = await runtime.session();
  return { context: baseContext(context, { session }), session };
};

flowSlices.runFinalOnboardFlowSequence = async ({ context, phases }) => {
  if (dashboardScenario) {
    registry.registerSandbox({
      name: "fsm-sandbox",
      agent: "hermes",
      provider: "openai-api",
      model: "gpt-test",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    const agentSetupPhase = phases.find((phase) => phase.state === "agent_setup");
    if (!agentSetupPhase) throw new Error("agent setup phase was not composed");
    await agentSetupPhase.run(context);
    const finalizationPhase = phases.find((phase) => phase.state === "finalizing");
    if (!finalizationPhase) throw new Error("finalization phase was not composed");
    await finalizationPhase.run(context);

    const dashboardOutput = [];
    await require(${dashboardUrlCommandPath}).runDashboardUrlCommand(
      "fsm-sandbox",
      { quiet: true },
      {
        fetchToken: () => null,
        getSandbox: (name) => registry.getSandbox(name),
        getAgentDashboardAuth: () => "session",
        log: (message) => dashboardOutput.push(String(message)),
      },
    );
    called.push("registry-port:" + String(registry.getSandbox("fsm-sandbox")?.dashboardPort));
    called.push("dashboard-url:" + String(dashboardOutput.at(-1)));
    throw sentinel;
  }
  called.push("final");
  if (scenario.slice === "final") throw sentinel;
  throw new Error("unexpected final slice fallthrough");
};

if (scenario.mode === "resume-initial") {
  seedResumeSession("preflight");
}
if (scenario.mode.includes("core-gateway")) {
  seedResumeSession("inference", scenario.mode !== "resume-incomplete-core-gateway");
}
if (
  scenario.mode === "resume-core-gateway" ||
  scenario.mode === "resume-incomplete-core-gateway" ||
  scenario.mode === "resume-core-gateway-provenance-resolver"
) {
  registry.registerSandbox({
    name: "fsm-sandbox",
    provider: "openai-api",
    model: "gpt-test",
    endpointUrl: "https://persisted.example.test/v1",
    endpointSource: "onboard",
    gatewayName: "nemoclaw-9090",
    gatewayPort: 9090,
  });
}

if (scenario.mode === "stale-recovery-admission") {
  const listRetainedSandboxRecoveryRecords =
    onboardSession.listRetainedSandboxRecoveryRecords;
  let recoveryReads = 0;
  onboardSession.listRetainedSandboxRecoveryRecords = () => {
    recoveryReads += 1;
    if (recoveryReads === 1) {
      onboardSession.recordRetainedSandboxRecovery({
        sandboxName: "fsm-sandbox",
        sandboxIdentityFingerprint: "a".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "stale-admission-generation",
        createAttemptNonce: "c".repeat(62),
        resources: {
          sharedInferenceProviders: [],
          sandboxScopedProviders: [],
          credentialEnvironmentVariables: [],
        },
        reason: "retained_after_sandbox_creation_failure",
      });
      return [];
    }
    return listRetainedSandboxRecoveryRecords();
  };
  process.exit = () => {
    throw staleAdmissionExit;
  };
}

if (scenario.mode === "stale-session-decision") {
  const resolveEntryOptions = onboardEntryOptions.readOptions;
  let optionReads = 0;
  onboardEntryOptions.readOptions = (...args) => {
    optionReads += 1;
    const resolved = resolveEntryOptions(...args);
    if (optionReads === 1) {
      seedResumeSession("preflight", false);
    }
    return resolved;
  };
  lockedRuntime.prepare = async (_opts, resume) => {
    called.push("locked-resume:" + String(resume));
    throw sentinel;
  };
}

const ownsAuthoritativeOnboardLock = scenario.mode.startsWith("authoritative-");
if (ownsAuthoritativeOnboardLock) {
  const lock = onboardSession.acquireOnboardLock("authoritative rebuild fixture");
  if (!lock.acquired) throw new Error("authoritative rebuild fixture did not acquire onboard lock");
}

const { onboard } = require(${onboardPath});

(async () => {
  try {
    if (scenario.mode === "dashboard-spawn-failure") {
      await require(${JSON.stringify(path.join(repoRoot, "src/lib/actions/onboard.ts"))}).runOnboardAction({
        "non-interactive": true,
        yes: true,
        "yes-i-accept-third-party-software": true,
        "no-gpu": true,
        name: "fsm-sandbox",
      });
      throw new Error("onboarding unexpectedly succeeded");
    }
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "fsm-sandbox",
      apfInterceptorRequested:
        scenario.mode === "providerless-staged-messaging" ||
        scenario.mode === "providerless-external-component",
      resume: scenario.mode === "resume-initial" || scenario.mode.includes("core-gateway"),
      ...(scenario.mode.startsWith("authoritative-")
        ? {
            authoritativeResumeConfig: true,
            recreateSandbox: true,
            onboardLockAlreadyHeld: true,
            targetGatewayName: "nemoclaw-9090",
            targetGatewayPort: 9090,
          }
        : {}),
    });
    throw new Error("expected slice sentinel");
  } catch (error) {
    if (ownsAuthoritativeOnboardLock) onboardSession.releaseOnboardLock();
    if (scenario.mode === "dashboard-spawn-failure") {
      called.push("failure:" + String(error?.message));
      console.log("__RESULT__" + JSON.stringify({ called }));
      return;
    }
    if (
      error === sentinel ||
      error?.message === sentinel.message ||
      (scenario.mode === "stale-recovery-admission" && error === staleAdmissionExit) ||
      (scenario.mode === "endpoint-override" &&
        error?.name === "OpenShellGatewayEndpointOverrideError") ||
      (scenario.mode === "providerless-staged-messaging" &&
        /supports providerless sandbox creation only/.test(String(error?.message)))
    ) {
      const payload = "__RESULT__" + JSON.stringify({ called });
      if (dashboardScenario) {
        process.stdout.write(payload + "\\n", () => process.exit(0));
        return;
      }
      console.log(payload);
      return;
    }
    console.error(error);
    process.exit(1);
  }
})();
`,
    );

    const result = await runOnboardProcessAsync(
      ["--require", path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"), scriptPath],
      {
        cwd: repoRoot,
        env: {
          ...probeEnvironment(tmpDir),
          ...(scenario.mode === "endpoint-override"
            ? { OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:65535" }
            : {}),
          ...(options.policyTier ? { NEMOCLAW_POLICY_TIER: options.policyTier } : {}),
          ...(scenario.mode === "providerless-staged-messaging"
            ? {
                NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(
                  JSON.stringify({
                    schemaVersion: 1,
                    sandboxName: "fsm-sandbox",
                    agent: "openclaw",
                    workflow: "onboard",
                    channels: [{ channelId: "telegram", active: true }],
                  }),
                ).toString("base64"),
              }
            : {}),
        },
        timeoutMs: scenario.mode === "dashboard-port-composition" ? 60_000 : probeTimeoutMs,
        context,
      },
    );
    assert.equal(result.status, 0, probeFailureMessage(result));
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const resultLine = [...lines].reverse().find((line) => line.startsWith("__RESULT__"));
    const payload = JSON.parse(resultLine?.slice("__RESULT__".length) || "{}") as {
      called?: string[];
    };
    assert.ok(
      Array.isArray(payload.called),
      `slice probe did not return called slices\n${probeFailureMessage(result)}`,
    );
    return payload.called as string[];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe.concurrent("live onboard FSM slice boundaries", () => {
  /*
   * The live dispatcher is still loaded from compiled CommonJS:
   * src/lib/onboard.ts captures these helpers through require-time bindings,
   * and a source-level Vitest import cannot replace them without adding a
   * production-only injection seam. Keep the monkeypatch in a short-lived
   * child process, with a minimal environment and a timeout, until onboard's
   * dispatcher exposes an explicit test hook or moves to source-testable ESM.
   */
  beforeAll(() => {
    assertFreshDistArtifacts();
  });

  it("removes its workspace when cancelled before child launch", async (context) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-fsm-cleanup-"));
    const launchMarkerPath = path.join(workspaceRoot, "child-launched");
    const controller = new AbortController();
    const reason = new Error("fixture test cancelled");
    controller.abort(reason);
    try {
      await assert.rejects(
        runSliceProbe(
          { launchMarkerPath, slice: "initial", workspaceRoot },
          { signal: controller.signal, onTestFinished: context.onTestFinished },
        ),
        (error: unknown) => error === reason,
      );
      assert.equal(fs.existsSync(launchMarkerPath), false);
      assert.deepEqual(fs.readdirSync(workspaceRoot), []);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("waits for an actively cancelled child to close before removing its workspace", async (context) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-fsm-active-"));
    const controller = new AbortController();
    const probe = runSliceProbe(
      { slice: "initial", mode: "active-cancellation", workspaceRoot },
      { signal: controller.signal, onTestFinished: context.onTestFinished },
    );
    let childWorkspace = path.join(workspaceRoot, "pending");
    let childPid = 0;
    let closeHolderPid = 0;
    let probeSettled = false;
    void probe.then(
      () => {
        probeSettled = true;
      },
      () => {
        probeSettled = true;
      },
    );
    try {
      await vi.waitFor(
        () => {
          const [workspace] = fs.readdirSync(workspaceRoot);
          assert.ok(workspace);
          childWorkspace = path.join(workspaceRoot, workspace);
          const pidPath = path.join(childWorkspace, "active-child.pid");
          const closeHolderPath = path.join(childWorkspace, "active-close-hold.ready");
          assert.ok(fs.existsSync(pidPath));
          assert.ok(fs.existsSync(closeHolderPath));
          childPid = Number(fs.readFileSync(pidPath, "utf8"));
          closeHolderPid = Number(fs.readFileSync(closeHolderPath, "utf8"));
          assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
          assert.ok(Number.isSafeInteger(closeHolderPid) && closeHolderPid > 0);
          process.kill(childPid, 0);
          process.kill(closeHolderPid, 0);
        },
        { timeout: 5_000, interval: 10 },
      );

      controller.abort(new Error("fixture test cancelled after launch"));
      await vi.waitFor(
        () => {
          assert.throws(
            () => process.kill(childPid, 0),
            (error: NodeJS.ErrnoException) => error.code === "ESRCH",
          );
        },
        { timeout: 5_000, interval: 10 },
      );
      assert.equal(probeSettled, false);
      assert.ok(fs.existsSync(childWorkspace));
      process.kill(closeHolderPid, 0);
      await vi.waitFor(() => assert.equal(probeSettled, true), {
        timeout: 5_000,
        interval: 10,
      });
      await assert.rejects(probe, /slice probe exited with status null and signal SIGKILL/u);
      assert.throws(
        () => process.kill(closeHolderPid, 0),
        (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      );
      assert.deepEqual(fs.readdirSync(workspaceRoot), []);
    } finally {
      controller.abort();
      try {
        fs.writeFileSync(path.join(childWorkspace, "active-close-hold.release"), "");
      } catch {
        // The workspace may already be gone after a successful close and cleanup.
      }
      await probe.catch(() => undefined);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("enters the initial slice on fresh onboard runs", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "initial" }, context), ["initial:init"]);
  });

  it("rejects an ambient gateway endpoint before entering the initial slice", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "initial", mode: "endpoint-override" }, context),
      [],
    );
  });

  it("rejects staged messaging before entering the onboarding state machine (#9833)", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "initial", mode: "providerless-staged-messaging" }, context),
      [],
    );
  });

  it(
    "validates the registered component before providerless onboarding effects (#11486)",
    async (context) => {
      assert.deepEqual(
        await runSliceProbe({ slice: "initial", mode: "providerless-external-component" }, context),
        ["component-validated", "preflight-effect", "gateway-effect", "sandbox-effect"],
      );
    },
    probeTimeoutMs,
  );

  it("rechecks retained sandbox admission after acquiring the onboarding lock (#9833)", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "initial", mode: "stale-recovery-admission" }, context),
      [],
    );
  });

  it("uses the session decision read after acquiring the onboarding lock (#9833)", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "initial", mode: "stale-session-decision" }, context),
      ["locked-resume:true"],
    );
  });

  it("enters the core slice after the initial slice reaches provider selection", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "core" }, context), ["initial:init", "core"]);
  });

  it("enters the final slice after the core slice reaches the branch state", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "final" }, context), [
      "initial:init",
      "core",
      "final",
    ]);
  });

  it("reports a sanitized adapter failure for a missing forward executable (#9808, #11648)", async (context) => {
    const called = await runSliceProbe(
      { slice: "final", mode: "dashboard-spawn-failure" },
      context,
    );
    assert.ok(called.includes("forward-launch"), JSON.stringify(called));
    assert.match(called.at(-1) ?? "", /failure:.*could not prove the forward state/i);
    assert.doesNotMatch(called.at(-1) ?? "", /ENOENT|missing-openshell/);
    assert.ok(!called.includes("terminate-process-tree"));
    assert.ok(!called.some((entry) => entry.startsWith("registry-port:")));
  }, 60_000);

  it("keeps the single dashboard port established during agent onboarding (#8214)", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "final", mode: "dashboard-port-composition" }, context),
      [
        "initial:init",
        "core",
        "agent-executor:function",
        "forward-port:18791",
        "registry-port:18791",
        "dashboard-url:http://127.0.0.1:18791/",
      ],
    );
  }, 60_000);

  it("enters the strict initial runner at preflight on an exact-state resume", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "initial", mode: "resume-initial" }, context), [
      "initial:preflight",
    ]);
  });

  it("bypasses the strict core runner when fresh state is already past the core entry", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "core", mode: "ahead-core" }, context), [
      "initial:init",
      "provider-compat",
    ]);
  });

  it("routes ordinary resume through the sandbox's recorded gateway", async (context) => {
    assert.deepEqual(await runSliceProbe({ slice: "core", mode: "resume-core-gateway" }, context), [
      "gateway:nemoclaw-9090:nemoclaw-9090",
      "provider-compat:nemoclaw-9090",
    ]);
  });

  it("routes an incomplete registered resume through its requested sandbox gateway", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "core", mode: "resume-incomplete-core-gateway" }, context),
      ["gateway:nemoclaw-9090:nemoclaw-9090", "provider-compat:nemoclaw-9090"],
    );
  });

  it("wires the live sandbox registry resolver into core provenance", async (context) => {
    assert.deepEqual(
      await runSliceProbe(
        { slice: "core", mode: "resume-core-gateway-provenance-resolver" },
        context,
      ),
      [
        "gateway:nemoclaw-9090:nemoclaw-9090",
        "registry-provenance:openai-api:https://persisted.example.test/v1:onboard",
      ],
    );
  });

  it("keeps an authoritative rebuild gateway after the registry row is removed", async (context) => {
    assert.deepEqual(
      await runSliceProbe({ slice: "core", mode: "authoritative-core-gateway" }, context),
      ["gateway:nemoclaw-9090:nemoclaw-9090", "provider-compat:nemoclaw-9090"],
    );
  });

  it.for(["balanced", "restricted"] as const)(
    "leaves ordinary policy tiers non-authoritative in the runOnboard machine [case %#]",
    async (policyTier, context) => {
      assert.deepEqual(
        await runSliceProbe({ slice: "core", mode: "ordinary-policy-tier", policyTier }, context),
        ["initial:init", "authoritative-policy-tier:undefined"],
      );
    },
  );

  it("does not carry a policy tier through authoritative rebuild state", async (context) => {
    const called = await runSliceProbe(
      {
        slice: "core",
        mode: "authoritative-core-gateway-policy-tier",
      },
      context,
    );
    assert.equal(called.at(-1), "authoritative-policy-tier:undefined");
  });
});
