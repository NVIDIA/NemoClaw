// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

type LifecyclePayload = {
  calls: Array<{
    resumed: boolean;
    sessionBeforeExists: boolean;
    mode: string | null;
    sandboxName: string | null;
  }>;
  events: Array<{ type: string; state: string | null; step: string | null }>;
};

type ResumeConflictPayload = {
  exitCode: number;
  stderr: string;
  events: Array<{
    type: string;
    state: string | null;
    metadata: Record<string, unknown>;
  }>;
};

function runOnboardEntrypoint<T>(
  scriptPath: string,
  repoRoot: string,
  envOverrides: Record<string, string> = {},
): T {
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides };
  delete env.NEMOCLAW_NON_INTERACTIVE;
  delete env.NEMOCLAW_SANDBOX_NAME;
  delete env.NEMOCLAW_FROM_DOCKERFILE;
  delete env.NEMOCLAW_PROVIDER;
  delete env.NEMOCLAW_MODEL;

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${result.stdout}`);
  return JSON.parse(line) as T;
}

function runLifecycleEntrypoint(mode: "fresh" | "resume" | "recovery"): LifecyclePayload {
  const repoRoot = path.join(import.meta.dirname, "../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-lifecycle-"));
  const scriptPath = path.join(tmpDir, `onboard-lifecycle-${mode}.cjs`);
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const runtimeBoundaryPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "runtime-boundary.ts"),
  );
  const eventsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "events.ts"),
  );
  const checkpointPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "state", "onboard-checkpoint-migrate.ts"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const { OnboardRuntimeBoundary } = require(${runtimeBoundaryPath});
const eventsModule = require(${eventsPath});
const emittedEvents = [];
eventsModule.addOnboardMachineEventListener((event) => emittedEvents.push(event));

const sentinel = new Error("stop after onboard lifecycle event");
const originalRecordOnboardStarted = OnboardRuntimeBoundary.prototype.recordOnboardStarted;
const calls = [];
OnboardRuntimeBoundary.prototype.recordOnboardStarted = async function(resumed) {
  const onboardSession = require(${onboardPath}).onboardSession;
  const sessionBefore = onboardSession.loadSession();
  calls.push({
    resumed,
    sessionBeforeExists: sessionBefore !== null,
    mode: sessionBefore?.mode ?? null,
    sandboxName: sessionBefore?.sandboxName ?? null,
  });
  await originalRecordOnboardStarted.call(this, resumed);
  throw sentinel;
};

const onboardModule = require(${onboardPath});
const { deriveCheckpointFromSession } = require(${checkpointPath});
if (${JSON.stringify(mode)} === "resume") {
  const session = onboardModule.onboardSession.createSession({
    mode: "non-interactive",
    sandboxName: "resume-lifecycle",
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  });
  session.checkpoint = deriveCheckpointFromSession(session, { profile: "default" });
  onboardModule.onboardSession.saveSession(session);
}
if (${JSON.stringify(mode)} === "recovery") {
  const session = onboardModule.onboardSession.createSession({
    mode: "non-interactive",
    sandboxName: "resume-lifecycle",
    status: "failed",
    lastStepStarted: "gateway",
    failure: {
      step: "gateway",
      message: "gateway failed",
      recordedAt: "2026-05-27T00:00:00.000Z",
    },
    machine: {
      version: 1,
      state: "failed",
      stateEnteredAt: "2026-05-27T00:00:00.000Z",
      revision: 4,
    },
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  });
  session.steps.gateway.status = "failed";
  session.checkpoint = deriveCheckpointFromSession(session, { profile: "default" });
  onboardModule.onboardSession.saveSession(session);
}

const options = {
  resume: ${JSON.stringify(mode)} !== "fresh",
  nonInteractive: true,
  acceptThirdPartySoftware: true,
  sandboxName: "fresh-lifecycle",
  noGpu: true,
};

onboardModule.onboard(options).then(
  () => {
    throw new Error("expected lifecycle spy to abort onboarding");
  },
  (error) => {
    if (error !== sentinel && error?.message !== sentinel.message) {
      console.error(error?.stack || error);
      process.exit(1);
    }
    console.log(JSON.stringify({
      calls,
      events: emittedEvents.map((event) => ({
        type: event.type,
        state: event.state,
        step: event.step,
      })),
    }));
  },
);
`,
  );

  try {
    return runOnboardEntrypoint<LifecyclePayload>(scriptPath, repoRoot, { HOME: tmpDir });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runInterruptedDcodeOnboard(mode: "thread-opt-in" | "disabled") {
  const repoRoot = path.join(import.meta.dirname, "../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-interruption-"));
  const scriptPath = path.join(tmpDir, "onboard.cjs");
  const modulePath = (relative: string) => JSON.stringify(path.join(repoRoot, relative));
  fs.writeFileSync(
    scriptPath,
    `
const { OnboardRuntimeBoundary } = require(${modulePath("src/lib/onboard/runtime-boundary.ts")});
const onboard = require(${modulePath("src/lib/onboard.ts")});
const sentinel = new Error("interrupt before sandbox registration");
const original = OnboardRuntimeBoundary.prototype.recordOnboardStarted;
let observedResume;
OnboardRuntimeBoundary.prototype.recordOnboardStarted = async function(resumed) {
  observedResume = resumed;
  await original.call(this, resumed);
  throw sentinel;
};
const resume = process.env.TEST_RESUME === "1";
onboard.onboard({
  nonInteractive: true,
  acceptThirdPartySoftware: true,
  noGpu: true,
  agent: "langchain-deepagents-code",
  sandboxName: "dcode-interrupted",
  resume,
  ...(resume ? {} : { dcodeAutoApprovalMode: ${JSON.stringify(mode)} }),
}).then(() => {
  throw new Error("expected interruption");
}, (error) => {
  if (error !== sentinel) throw error;
  const session = onboard.onboardSession.loadSession();
  console.log(JSON.stringify({
    resumed: observedResume,
    sessionId: session.sessionId,
    mode: session.dcodeAutoApprovalMode,
    explicit: session.dcodeAutoApprovalRequestedExplicitly,
    sandboxName: session.sandboxName,
  }));
});
`,
  );
  type SavedCapability = {
    resumed: boolean;
    sessionId: string;
    mode: string | null;
    explicit: boolean;
    sandboxName: string | null;
  };
  try {
    const env = { HOME: tmpDir, NEMOCLAW_TEST_STATE_DIR: path.join(tmpDir, "state") };
    const fresh = runOnboardEntrypoint<SavedCapability>(scriptPath, repoRoot, {
      ...env,
      TEST_RESUME: "0",
    });
    const resumed = runOnboardEntrypoint<SavedCapability>(scriptPath, repoRoot, {
      ...env,
      TEST_RESUME: "1",
    });
    return { fresh, resumed };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runResumeConflictEntrypoint(
  options: { failEventEmission?: boolean } = {},
): ResumeConflictPayload {
  const repoRoot = path.join(import.meta.dirname, "../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-conflict-"));
  const scriptPath = path.join(tmpDir, "onboard-resume-conflict.cjs");
  const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
  const runtimeBoundaryPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "runtime-boundary.ts"),
  );
  const eventsPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "onboard", "machine", "events.ts"),
  );
  const checkpointPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "state", "onboard-checkpoint-migrate.ts"),
  );

  fs.writeFileSync(
    scriptPath,
    `
const eventsModule = require(${eventsPath});
const emittedEvents = [];
const stderrLines = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  stderrLines.push(args.join(" "));
  originalConsoleError(...args);
};
eventsModule.addOnboardMachineEventListener((event) => emittedEvents.push(event));

const { OnboardRuntimeBoundary } = require(${runtimeBoundaryPath});
if (${JSON.stringify(options.failEventEmission)}) {
  OnboardRuntimeBoundary.prototype.recordResumeConflict = async () => {
    throw new Error("synthetic resume-conflict event failure");
  };
}

class ExitSignal extends Error {
  constructor(code) {
    super('process.exit(' + code + ')');
    this.code = code;
  }
}
process.exit = ((code = 0) => {
  throw new ExitSignal(code);
});

const onboardModule = require(${onboardPath});
const { deriveCheckpointFromSession } = require(${checkpointPath});
const session = onboardModule.onboardSession.createSession({
  mode: "non-interactive",
  sandboxName: "recorded-sandbox",
  metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
  steps: {
    sandbox: {
      status: "complete",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:00:01.000Z",
      error: null,
    },
  },
});
session.checkpoint = deriveCheckpointFromSession(session, { profile: "default" });
onboardModule.onboardSession.saveSession(session);

onboardModule.onboard({
  resume: true,
  nonInteractive: true,
  acceptThirdPartySoftware: true,
  sandboxName: "requested-sandbox",
  fromDockerfile: "https://alice:secret@example.com/Dockerfile?token=super-secret",
  noGpu: true,
}).then(
  () => {
    throw new Error("expected resume conflict to abort onboarding");
  },
  (error) => {
    if (!(error instanceof ExitSignal) || error.code !== 1) {
      console.error(error?.stack || error);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({
      exitCode: error.code,
      stderr: stderrLines.join("\\n"),
      events: emittedEvents.map((event) => ({
        type: event.type,
        state: event.state,
        metadata: event.metadata,
      })),
    }));
  },
);
`,
  );

  try {
    return runOnboardEntrypoint<ResumeConflictPayload>(scriptPath, repoRoot, { HOME: tmpDir });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("onboard entrypoint lifecycle events", () => {
  it.each(["thread-opt-in", "disabled"] as const)(
    "preserves explicit DCode mode %s across interruption before sandbox registration",
    (mode) => {
      const { fresh, resumed } = runInterruptedDcodeOnboard(mode);
      assert.equal(fresh.resumed, false);
      assert.equal(fresh.mode, mode);
      assert.equal(fresh.explicit, true);
      assert.equal(fresh.sandboxName, null);
      assert.deepEqual(resumed, { ...fresh, resumed: true });
    },
  );

  it("emits onboard.started after creating a fresh session", () => {
    const payload = runLifecycleEntrypoint("fresh");

    assert.deepEqual(payload.calls, [
      {
        resumed: false,
        sessionBeforeExists: true,
        mode: "non-interactive",
        sandboxName: null,
      },
    ]);
    assert.deepEqual(payload.events, [{ type: "onboard.started", state: "init", step: null }]);
  });

  it("emits onboard.resumed after loading a resumable session", () => {
    const payload = runLifecycleEntrypoint("resume");

    assert.deepEqual(payload.calls, [
      {
        resumed: true,
        sessionBeforeExists: true,
        mode: "non-interactive",
        sandboxName: "resume-lifecycle",
      },
    ]);
    assert.deepEqual(payload.events, [{ type: "onboard.resumed", state: "init", step: null }]);
  });

  it("emits recovery completion after onboard.resumed (#6227)", () => {
    const payload = runLifecycleEntrypoint("recovery");

    assert.deepEqual(payload.calls, [
      {
        resumed: true,
        sessionBeforeExists: true,
        mode: "non-interactive",
        sandboxName: "resume-lifecycle",
      },
    ]);
    assert.deepEqual(payload.events, [
      { type: "onboard.resumed", state: "gateway", step: null },
      { type: "state.repair.completed", state: "gateway", step: null },
    ]);
  });

  it("emits one resume.conflict event for each resume mismatch before exiting", () => {
    const payload = runResumeConflictEntrypoint();

    assert.equal(payload.exitCode, 1);
    assert.equal(JSON.stringify(payload.events).includes("super-secret"), false);
    assert.equal(JSON.stringify(payload.events).includes("alice:secret"), false);
    assert.deepEqual(
      payload.events.map((event) => ({
        type: event.type,
        state: event.state,
        field: event.metadata.field,
        recorded: event.metadata.recorded,
        requested: event.metadata.requested,
      })),
      [
        {
          type: "resume.conflict",
          state: "init",
          field: "sandbox",
          recorded: "recorded-sandbox",
          requested: "requested-sandbox",
        },
        {
          type: "resume.conflict",
          state: "init",
          field: "fromDockerfile",
          recorded: null,
          requested: "<path>",
        },
      ],
    );
  });

  it("preserves resume conflict diagnostics when event emission fails", () => {
    const payload = runResumeConflictEntrypoint({ failEventEmission: true });

    assert.equal(payload.exitCode, 1);
    assert.deepEqual(payload.events, []);
    assert.match(
      payload.stderr,
      /Resumable state belongs to sandbox 'recorded-sandbox', not 'requested-sandbox'/,
    );
    assert.match(payload.stderr, /Run: nemoclaw onboard/);
    assert.doesNotMatch(payload.stderr, /synthetic resume-conflict event failure/);
  });

  it("forwards rebuild permission through the real onboarding entry (#11199)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-shields-handoff-"));
    const scriptPath = path.join(tmpDir, "shields-handoff.cjs");
    const modulePath = (relative: string) => JSON.stringify(path.join(repoRoot, relative));
    fs.writeFileSync(
      scriptPath,
      `
const initial = require(${modulePath("src/lib/onboard/machine/initial-flow-phases.ts")});
const coreRaw = require(${modulePath("src/lib/onboard/machine/core-flow-phases.ts")});
const core = require(${modulePath("src/lib/onboard/machine/core-flow-composition.ts")});
const create = require(${modulePath("src/lib/onboard/sandbox-create/orchestration.ts")});
const { resolveNemoclawStateDir } = require(${modulePath("src/lib/state/paths.ts")});
const fs = require("node:fs");
const path = require("node:path");
require(${modulePath("src/lib/onboard/docker-driver-gateway-service.ts")}).hasOpenShellGatewayUserService = () => false;
require(${modulePath("test/helpers/onboard-script-mocks.cjs")}).mockStandaloneGatewayTeardownAuthority();
const stop = new Error("stop after onboarding handoff");
const allowed = process.env.TEST_ALLOW_SHIELDS_RECORD === "1";
const record = path.join(resolveNemoclawStateDir(), "shields-shields-handoff.json");
fs.mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
fs.writeFileSync(record, ${JSON.stringify("{}\n")});
let createSandbox;
initial.runInitialOnboardFlowSlice = async ({ context, runtime }) => ({
  context: { ...context, session: await runtime.session(), gpu: null,
    sandboxGpuConfig: { mode: "disabled", hostGpuPlatform: null },
    gpuPassthrough: false, requestedGpuPassthrough: false,
    resumeHasResolvedGpuIntent: true },
  session: await runtime.session(),
});
core.createCoreOnboardFlowPhases = (input) => {
  createSandbox = input.sandbox.deps.createSandbox;
  return {};
};
coreRaw.runCoreOnboardFlowSlice = async () => {
  const args = Array(17).fill(null);
  args[1] = "test-model";
  args[2] = "nvidia-prod";
  args[4] = "shields-handoff";
  args[12] = [];
  await createSandbox(...args);
  throw stop;
};
const realCreate = create.createSandboxWithBaseImageResolution;
create.createSandboxWithBaseImageResolution = (runtime) => realCreate(new Proxy(runtime, {
  get(target, key) {
    if (key === "preparedDcodeRebuild") {
      return { ...target.preparedDcodeRebuild, assertPreparedDcodeTarget: () => { throw stop; } };
    }
    return Reflect.get(target, key);
  },
}));
const { onboard } = require(${modulePath("src/lib/onboard.ts")});
onboard({ nonInteractive: true, acceptThirdPartySoftware: true, noGpu: true,
  sandboxName: "shields-handoff",
  ...(allowed ? { allowRemovedImmutabilityStateRecord: true } : {}) })
  .then(() => { throw new Error("onboard unexpectedly completed"); }, (error) => {
    console.log(JSON.stringify({ guardPassed: error === stop || error?.message === stop.message,
      error: error?.stack || error?.message, recordRetained: fs.existsSync(record) }));
  });
`,
    );
    try {
      const run = (allowed: boolean) =>
        runOnboardEntrypoint<{ guardPassed: boolean; error: string; recordRetained: boolean }>(
          scriptPath,
          repoRoot,
          {
            HOME: path.join(tmpDir, allowed ? "allowed" : "denied"),
            TEST_ALLOW_SHIELDS_RECORD: allowed ? "1" : "0",
          },
        );
      const denied = run(false);
      assert.equal(denied.guardPassed, false);
      assert.match(denied.error, /has a state record from the removed Shields feature/);
      assert.equal(denied.recordRetained, true);
      const permitted = run(true);
      assert.equal(permitted.guardPassed, true, permitted.error);
      assert.equal(permitted.recordRetained, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
