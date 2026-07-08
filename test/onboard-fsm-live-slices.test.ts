// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const probeTimeoutMs = 10_000;

type SliceName = "initial" | "core" | "final";
type ProbeMode =
  | "fresh"
  | "endpoint-override"
  | "resume-initial"
  | "resume-core-gateway"
  | "resume-incomplete-core-gateway"
  | "authoritative-core-gateway"
  | "ahead-core";

interface ProbeOptions {
  slice: SliceName;
  mode?: ProbeMode;
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
  fs.writeFileSync(openshellPath, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
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
  const preflightHandlerPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "preflight.ts"),
  );
  const providerHandlerPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "provider-inference.ts"),
  );
  const gatewayHandlerPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "gateway.ts"),
  );
  const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));

  fs.writeFileSync(
    scriptPath,
    `
const scenario = ${JSON.stringify(scenario)};
const flowSlices = require(${flowSlicesPath});
const { advanceTo, branchTo } = require(${resultPath});
const onboardSession = require(${sessionPath});
const preflightHandlers = require(${preflightHandlerPath});
const providerHandlers = require(${providerHandlerPath});
const gatewayHandlers = require(${gatewayHandlerPath});
const registry = require(${registryPath});
const called = [];
const sentinel = new Error("slice-called");

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
  if (scenario.mode !== "resume-initial") {
    throw new Error("unexpected preflight compatibility handler");
  }
  called.push("preflight-compat");
  throw sentinel;
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
  called.push("initial");
  if (scenario.mode === "resume-initial") {
    throw new Error("strict initial runner should not run on resume");
  }
  if (scenario.slice === "initial") throw sentinel;
  const initialSession = await runtime.session();
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
  await runtime.applyResult(branchTo("openclaw", { metadata: { state: "sandbox" } }));
  const session = await runtime.session();
  return { context: baseContext(context, { session }), session };
};

flowSlices.runFinalOnboardFlowSequence = async ({ context }) => {
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
if (scenario.mode === "resume-core-gateway" || scenario.mode === "resume-incomplete-core-gateway") {
  registry.registerSandbox({
    name: "fsm-sandbox",
    provider: "openai-api",
    model: "gpt-test",
    gatewayName: "nemoclaw-9090",
    gatewayPort: 9090,
  });
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
      resume: scenario.mode === "resume-initial" || scenario.mode.includes("core-gateway"),
      ...(scenario.mode === "authoritative-core-gateway"
        ? {
            authoritativeResumeConfig: true,
            targetGatewayName: "nemoclaw-9090",
            targetGatewayPort: 9090,
          }
        : {}),
    });
    throw new Error("expected slice sentinel");
  } catch (error) {
    if (
      error === sentinel ||
      error?.message === sentinel.message ||
      (scenario.mode === "endpoint-override" &&
        error?.name === "OpenShellGatewayEndpointOverrideError")
    ) {
      console.log(JSON.stringify({ called }));
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
      },
      timeout: probeTimeoutMs,
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
    assert.deepEqual(runSliceProbe({ slice: "initial" }), ["initial"]);
  });

  it("rejects an ambient gateway endpoint before entering the initial slice", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "endpoint-override" }), []);
  });

  it("enters the core slice after the initial slice reaches provider selection", () => {
    assert.deepEqual(runSliceProbe({ slice: "core" }), ["initial", "core"]);
  });

  it("enters the final slice after the core slice reaches the branch state", () => {
    assert.deepEqual(runSliceProbe({ slice: "final" }), ["initial", "core", "final"]);
  });

  it("bypasses the strict initial runner on resume and reaches compatibility phases", () => {
    assert.deepEqual(runSliceProbe({ slice: "initial", mode: "resume-initial" }), [
      "preflight-compat",
    ]);
  });

  it("bypasses the strict core runner when fresh state is already past the core entry", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "ahead-core" }), [
      "initial",
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

  it("keeps an authoritative rebuild gateway after the registry row is removed", () => {
    assert.deepEqual(runSliceProbe({ slice: "core", mode: "authoritative-core-gateway" }), [
      "gateway:nemoclaw-9090:nemoclaw-9090",
      "provider-compat:nemoclaw-9090",
    ]);
  });
});
