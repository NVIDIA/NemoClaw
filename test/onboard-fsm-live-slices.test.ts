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
type ProbeMode = "fresh" | "resume-initial" | "ahead-core";

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
    distPath: path.join(repoRoot, "dist", "lib", "onboard.js"),
  },
  {
    label: "flow slices",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
    distPath: path.join(repoRoot, "dist", "lib", "onboard", "machine", "flow-slices.js"),
  },
  {
    label: "state results",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
    distPath: path.join(repoRoot, "dist", "lib", "onboard", "machine", "result.js"),
  },
  {
    label: "session persistence",
    sourcePath: path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    distPath: path.join(repoRoot, "dist", "lib", "state", "onboard-session.js"),
  },
  {
    label: "preflight handler",
    sourcePath: path.join(repoRoot, "src", "lib", "onboard", "machine", "handlers", "preflight.ts"),
    distPath: path.join(repoRoot, "dist", "lib", "onboard", "machine", "handlers", "preflight.js"),
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
      "dist",
      "lib",
      "onboard",
      "machine",
      "handlers",
      "provider-inference.js",
    ),
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

function probeEnvironment(tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: tmpDir,
    TMPDIR: tmpDir,
    PATH: process.env.PATH || "/usr/bin:/bin",
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
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const flowSlicesPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "flow-slices.js"),
  );
  const resultPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "result.js"),
  );
  const sessionPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "state", "onboard-session.js"),
  );
  const preflightHandlerPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "handlers", "preflight.js"),
  );
  const providerHandlerPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "handlers", "provider-inference.js"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const scenario = ${JSON.stringify(scenario)};
const flowSlices = require(${flowSlicesPath});
const { advanceTo, branchTo } = require(${resultPath});
const onboardSession = require(${sessionPath});
const preflightHandlers = require(${preflightHandlerPath});
const providerHandlers = require(${providerHandlerPath});
const called = [];
const sentinel = new Error("slice-called");

function machine(state, revision = 1) {
  return { version: 1, state, stateEnteredAt: null, revision };
}

function seedResumeSession(state) {
  onboardSession.saveSession(onboardSession.createSession({
    mode: "non-interactive",
    sandboxName: "fsm-sandbox",
    machine: machine(state),
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  }));
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

preflightHandlers.handlePreflightState = async () => {
  if (scenario.mode !== "resume-initial") {
    throw new Error("unexpected preflight compatibility handler");
  }
  called.push("preflight-compat");
  throw sentinel;
};

providerHandlers.handleProviderInferenceState = async () => {
  if (scenario.mode !== "ahead-core") {
    throw new Error("unexpected provider compatibility handler");
  }
  called.push("provider-compat");
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

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "fsm-sandbox",
      resume: scenario.mode === "resume-initial",
    });
    throw new Error("expected slice sentinel");
  } catch (error) {
    if (error === sentinel || error?.message === sentinel.message) {
      console.log(JSON.stringify({ called }));
      return;
    }
    console.error(error);
    process.exit(1);
  }
})();
`,
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: probeEnvironment(tmpDir),
    timeout: probeTimeoutMs,
  });
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
});
