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

function runLifecycleEntrypoint(mode: "fresh" | "resume"): LifecyclePayload {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-lifecycle-"));
  const scriptPath = path.join(tmpDir, `onboard-lifecycle-${mode}.cjs`);
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const runtimeBoundaryPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "runtime-boundary.js"),
  );
  const eventsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "events.js"),
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
if (${JSON.stringify(mode)} === "resume") {
  onboardModule.onboardSession.saveSession(
    onboardModule.onboardSession.createSession({
      mode: "non-interactive",
      sandboxName: "resume-lifecycle",
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    }),
  );
}

const options = {
  resume: ${JSON.stringify(mode)} === "resume",
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

function runResumeConflictEntrypoint(
  options: { failEventEmission?: boolean } = {},
): ResumeConflictPayload {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-conflict-"));
  const scriptPath = path.join(tmpDir, "onboard-resume-conflict.cjs");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const runtimeBoundaryPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "runtime-boundary.js"),
  );
  const eventsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "onboard", "machine", "events.js"),
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
onboardModule.onboardSession.saveSession(
  onboardModule.onboardSession.createSession({
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
  }),
);

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
});
