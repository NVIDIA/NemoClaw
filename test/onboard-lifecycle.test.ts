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
    const env: Record<string, string | undefined> = { ...process.env, HOME: tmpDir };
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
    return JSON.parse(line) as LifecyclePayload;
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
});
