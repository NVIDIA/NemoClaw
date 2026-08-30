// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");
const probeTimeoutMs = 10_000;

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
  | "ordinary-policy-tier"
  | "providerless-staged-messaging"
  | "stale-recovery-admission"
  | "stale-session-decision"
  | "ahead-core";

interface ProbeOptions {
  slice: SliceName;
  mode?: ProbeMode;
  policyTier?: "balanced" | "restricted";
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
    `#!${process.execPath}\nif (process.argv[2] === "policy" && process.argv[3] === "list" && process.argv.includes("--global")) process.stderr.write("No global policy history found\\n");\nprocess.exit(0);\n`,
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

function probeFailureMessage(result: SpawnSyncReturns<string>): string {
  const details = [
    `slice probe exited with status ${result.status ?? "null"}${result.signal ? ` and signal ${result.signal}` : ""}`,
    result.error ? `error: ${redactProbeOutput(result.error.message)}` : null,
    result.stderr ? `stderr:\n${redactProbeOutput(result.stderr)}` : null,
    result.stdout ? `stdout:\n${redactProbeOutput(result.stdout)}` : null,
  ].filter(Boolean);
  return details.join("\n\n");
}

function runSliceProbe(options: ProbeOptions) {
  const scenario = { mode: options.mode ?? "fresh", slice: options.slice };
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `nemoclaw-onboard-fsm-${scenario.mode}-${scenario.slice}-`),
  );
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
  const agentOnboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "agent", "onboard.ts"));
  const agentSelectionPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "agent-selection.ts"),
  );
  const dashboardUrlCommandPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "dashboard-url-command.ts"),
  );
  const finalizationDepsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "finalization-deps.ts"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const scenario = ${JSON.stringify(scenario)};
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

if (scenario.mode === "dashboard-port-composition") {
  const finalizationHandlerDeps = require(${finalizationDepsPath}).finalizationHandlerDeps;
  finalizationHandlerDeps.checkAndRecoverSandboxProcesses = () => undefined;
  finalizationHandlerDeps.settleOrdinaryOpenClawPairing = async () => ({ kind: "settled" });
  const onboardDashboard = require(${onboardDashboardPath});
  const createOnboardDashboardHelpers = onboardDashboard.createOnboardDashboardHelpers;
  let dashboardForwardCalls = 0;
  onboardDashboard.createOnboardDashboardHelpers = (deps) => {
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
  require(${agentOnboardPath}).handleAgentSetup = async () => undefined;
  require(${agentSelectionPath}).createOnboardAgentSelector = () => async () => ({
    name: "hermes",
    displayName: "Hermes Agent",
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

flowSlices.runCoreOnboardFlowSequence = async ({ context, runtime }) => {
  called.push("core");
  if (scenario.mode === "ahead-core") {
    throw new Error("strict core runner should not run after an ahead-state handoff");
  }
  if (scenario.slice === "core") throw sentinel;
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", { metadata: { state: "inference" } }));
  await runtime.applyResult(
    branchTo(scenario.mode === "dashboard-port-composition" ? "agent_setup" : "openclaw", {
      metadata: { state: "sandbox" },
    }),
  );
  const session = await runtime.session();
  return { context: baseContext(context, { session }), session };
};

flowSlices.runFinalOnboardFlowSequence = async ({ context, phases }) => {
  if (scenario.mode === "dashboard-port-composition") {
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
    require(${dashboardUrlCommandPath}).runDashboardUrlCommand(
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
        verifiedEffectivePolicyIdentity: null,
        createAttemptNonce: "c".repeat(62),
        policyCreationReceipt: null,
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
  const resolveEntryOptions = onboardEntryOptions.resolveDefaultRunEntryOptionsFromState;
  let optionReads = 0;
  onboardEntryOptions.resolveDefaultRunEntryOptionsFromState = (...args) => {
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
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "fsm-sandbox",
      apfInterceptorRequested: scenario.mode === "providerless-staged-messaging",
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
    if (
      error === sentinel ||
      error?.message === sentinel.message ||
      (scenario.mode === "stale-recovery-admission" && error === staleAdmissionExit) ||
      (scenario.mode === "endpoint-override" &&
        error?.name === "OpenShellGatewayEndpointOverrideError") ||
      (scenario.mode === "providerless-staged-messaging" &&
        /supports providerless sandbox creation only/.test(String(error?.message)))
    ) {
      const payload = JSON.stringify({ called });
      if (scenario.mode === "dashboard-port-composition") {
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

  const result = spawnSync(
    process.execPath,
    ["--require", path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"), scriptPath],
    {
      cwd: repoRoot,
      encoding: "utf-8",
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
      timeout: scenario.mode === "dashboard-port-composition" ? 60_000 : probeTimeoutMs,
    },
  );
  try {
    assert.equal(result.status, 0, probeFailureMessage(result));
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const payload = JSON.parse(lines.at(-1) || "{}") as { called?: string[] };
    assert.ok(
      Array.isArray(payload.called),
      `slice probe did not return called slices\n${probeFailureMessage(result)}`,
    );
    return payload.called as string[];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("live onboard FSM slice boundaries", () => {
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

  it("enters the initial slice on fresh onboard runs", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial" }), ["initial:init"]);
  });

  it("rejects an ambient gateway endpoint before entering the initial slice", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "endpoint-override" }), []);
  });

  it("rejects staged messaging before entering the onboarding state machine (#9833)", () => {
    assert.deepEqual(
      runSliceProbe({ slice: "initial", mode: "providerless-staged-messaging" }),
      [],
    );
  });

  it("rechecks retained sandbox admission after acquiring the onboarding lock (#9833)", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "stale-recovery-admission" }), []);
  });

  it("uses the session decision read after acquiring the onboarding lock (#9833)", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "stale-session-decision" }), [
      "locked-resume:true",
    ]);
  });

  it("enters the core slice after the initial slice reaches provider selection", () => {
    assert.deepEqual(runSliceProbe({ slice: "core" }), ["initial:init", "core"]);
  });

  it("enters the final slice after the core slice reaches the branch state", () => {
    assert.deepEqual(runSliceProbe({ slice: "final" }), ["initial:init", "core", "final"]);
  });

  it("returns the post-recovery dashboard port after agent onboarding (#8214)", () => {
    assert.deepEqual(runSliceProbe({ slice: "final", mode: "dashboard-port-composition" }), [
      "initial:init",
      "core",
      "forward-port:18791",
      "forward-port:18792",
      "registry-port:18792",
      "dashboard-url:http://127.0.0.1:18792/",
    ]);
  }, 60_000);

  it("enters the strict initial runner at preflight on an exact-state resume", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "resume-initial" }), [
      "initial:preflight",
    ]);
  });

  it("bypasses the strict core runner when fresh state is already past the core entry", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "ahead-core" }), [
      "initial:init",
      "provider-compat",
    ]);
  });

  it("routes ordinary resume through the sandbox's recorded gateway", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "resume-core-gateway" }), [
      "gateway:nemoclaw-9090:nemoclaw-9090",
      "provider-compat:nemoclaw-9090",
    ]);
  });

  it("routes an incomplete registered resume through its requested sandbox gateway", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "resume-incomplete-core-gateway" }), [
      "gateway:nemoclaw-9090:nemoclaw-9090",
      "provider-compat:nemoclaw-9090",
    ]);
  });

  it("wires the live sandbox registry resolver into core provenance", () => {
    assert.deepEqual(
      runSliceProbe({ slice: "core", mode: "resume-core-gateway-provenance-resolver" }),
      [
        "gateway:nemoclaw-9090:nemoclaw-9090",
        "registry-provenance:openai-api:https://persisted.example.test/v1:onboard",
      ],
    );
  });

  it("keeps an authoritative rebuild gateway after the registry row is removed", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "authoritative-core-gateway" }), [
      "gateway:nemoclaw-9090:nemoclaw-9090",
      "provider-compat:nemoclaw-9090",
    ]);
  });

  it.each(["balanced", "restricted"] as const)(
    "leaves ordinary policy tiers non-authoritative in the runOnboard machine [case %#]",
    (policyTier) => {
      assert.deepEqual(runSliceProbe({ slice: "core", mode: "ordinary-policy-tier", policyTier }), [
        "initial:init",
        "authoritative-policy-tier:undefined",
      ]);
    },
  );

  it("preserves an explicit null policy tier for authoritative rebuilds", () => {
    const called = runSliceProbe({
      slice: "core",
      mode: "authoritative-core-gateway-policy-tier",
    });
    assert.equal(called.at(-1), "authoritative-policy-tier:null");
  });
});
