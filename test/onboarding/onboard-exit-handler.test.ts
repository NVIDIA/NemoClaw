// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

type OnboardModule = typeof import("../../src/lib/onboard") & {
  onboardSession: typeof import("../../src/lib/state/onboard-session");
  registerIncompleteOnboardExitHandlerForSession: (
    deps: typeof import("../../src/lib/state/onboard-session"),
    isComplete: () => boolean,
    processLike: { once(event: "exit", listener: (code: number) => void): unknown },
  ) => void;
};

const require = createRequire(import.meta.url);
const onboard = require("../../src/lib/onboard.js") as OnboardModule;
const onboardSession = onboard.onboardSession;
const ONBOARD_FIXTURE_PATH = ["/usr/bin", "/bin"].join(path.delimiter);
const originalHome = process.env.HOME;
const restoreOriginalHome =
  originalHome === undefined
    ? () => {
        delete process.env.HOME;
      }
    : () => {
        process.env.HOME = originalHome;
      };

function requireLoadedSession(sessionDeps = onboardSession) {
  const loaded = sessionDeps.loadSession();
  expect(loaded).not.toBeNull();
  return loaded ?? sessionDeps.createSession();
}

function writeSuccessfulOpenShell(tmpDir: string): string {
  const openshellPath = path.join(tmpDir, "openshell");
  fs.writeFileSync(openshellPath, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  return openshellPath;
}

describe("onboard exit handler registration", () => {
  let tmpDir: string;
  let listeners: Array<(code: number) => void>;
  const processLike = {
    once: (event: "exit", listener: (code: number) => void) => {
      expect(event).toBe("exit");
      listeners.push(listener);
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-exit-handler-"));
    process.env.HOME = tmpDir;
    listeners = [];
    onboardSession.clearSession();
  });

  afterEach(() => {
    onboardSession.clearSession();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreOriginalHome();
  });

  it("onboard marks an incomplete nonzero exit as a terminal machine failure", () => {
    onboardSession.saveSession(onboardSession.createSession({ lastStepStarted: "inference" }));

    onboard.registerIncompleteOnboardExitHandlerForSession(
      onboardSession,
      () => false,
      processLike,
    );
    listeners[0](0);
    expect(requireLoadedSession().status).toBe("in_progress");

    listeners[0](1);

    const loaded = requireLoadedSession();
    expect(loaded.steps.inference.status).toBe("failed");
    expect(loaded.status).toBe("failed");
    expect(loaded.failure?.step).toBe("inference");
    expect(loaded.failure?.message).toBe("Onboarding exited before the step completed.");
    expect(loaded.machine.state).toBe("failed");
  });

  it("onboard leaves completed nonzero exits untouched", () => {
    onboardSession.saveSession(onboardSession.createSession({ lastStepStarted: "inference" }));

    onboard.registerIncompleteOnboardExitHandlerForSession(onboardSession, () => true, processLike);
    listeners[0](1);

    const loaded = requireLoadedSession();
    expect(loaded.steps.inference.status).toBe("pending");
    expect(loaded.status).toBe("in_progress");
    expect(loaded.failure).toBeNull();
    expect(loaded.machine.state).toBe("init");
  });

  it("resumes clean validation exits while cleanup failures and unexpected exits stay terminal (#9732)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const scriptPath = path.join(tmpDir, "onboard-exit-registration.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const flowSlicesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
    );
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );
    const validationPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "inference-selection-validation.ts"),
    );
    const resultPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
    );

    fs.writeFileSync(
      scriptPath,
      `
const flowSlices = require(${flowSlicesPath});
const onboardSession = require(${sessionPath});
const validation = require(${validationPath});
const { advanceTo } = require(${resultPath});
const sentinel = new Error("stop-after-exit-registration");
const resumeSentinel = new Error("stop-after-resume-checkpoint");
const resumeRequested = process.argv.includes("--resume");
const exitListeners = [];
const originalOnce = process.once;
const originalExit = process.exit;
let resumeEvidence = null;

process.once = function once(event, listener) {
  if (event === "exit") {
    exitListeners.push(listener);
    return process;
  }
  return originalOnce.call(process, event, listener);
};
process.exit = function exit(code) {
  throw new Error("process.exit:" + String(code));
};

const validationHelpers = validation.createInferenceSelectionValidationHelpers({
  isNonInteractive: () => true,
  agentProductName: () => "OpenClaw",
  getCredential: () => "test-key",
  probeOpenAiLikeEndpoint: async () => ({
    ok: false,
    failures: [{ name: "Chat Completions API", httpStatus: 503 }],
  }),
  resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
  teardownOrphanManagedGatewayOnAbort: () =>
    process.env.NEMOCLAW_TEST_EXIT_KIND !== "validation-cleanup-failure",
  promptValidationRecovery: async () => "selection",
});

flowSlices.runInitialOnboardFlowSequence = async ({ context, runtime }) => {
  if (resumeRequested) {
    const before = await runtime.session();
    await runtime.applyResult(advanceTo("preflight", { metadata: { state: before.machine.state } }));
    const after = await runtime.session();
    resumeEvidence = {
      requested: context.resume,
      sessionId: before.sessionId,
      startingMachineState: before.machine.state,
      continuedMachineState: after.machine.state,
    };
    throw resumeSentinel;
  }
  await runtime.markStepStarted("preflight");
  if (process.env.NEMOCLAW_TEST_EXIT_KIND?.startsWith("validation")) {
    await validationHelpers.validateCustomOpenAiLikeSelection(
      "Custom endpoint",
      "https://endpoint.test/v1",
      "model-a",
      "COMPATIBLE_API_KEY",
    );
    throw new Error("expected validation exit");
  }
  throw sentinel;
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "exit-seam",
    });
    throw new Error("expected sentinel");
  } catch (error) {
    if (resumeRequested) {
      if (error !== resumeSentinel && error?.message !== resumeSentinel.message) throw error;
      const loaded = onboardSession.loadSession();
      console.log(JSON.stringify({ loaded, resumeEvidence, exitListeners: exitListeners.length }));
      return;
    }
    const validationExit = process.env.NEMOCLAW_TEST_EXIT_KIND?.startsWith("validation");
    if (
      (!validationExit && error !== sentinel && error?.message !== sentinel.message) ||
      (validationExit && error?.message !== "process.exit:1")
    ) {
      throw error;
    }
    const exitHandler = exitListeners.at(-1);
    if (!exitHandler) throw new Error("missing exit handler");
    exitHandler(1);
    const loaded = onboardSession.loadSession();
    console.log(JSON.stringify({ loaded, exitListeners: exitListeners.length }));
  } finally {
    process.once = originalOnce;
    process.exit = originalExit;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`,
    );

    const runOnboard = (
      home: string,
      exitKind: "unexpected" | "validation" | "validation-cleanup-failure" | "resume",
    ) =>
      spawnSync(process.execPath, [scriptPath, ...(exitKind === "resume" ? ["--resume"] : [])], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: ONBOARD_FIXTURE_PATH,
          TMPDIR: tmpDir,
          NEMOCLAW_TEST_EXIT_KIND: exitKind,
          NEMOCLAW_TEST_NO_SLEEP: "1",
        },
        timeout: 60_000,
      });

    const result = runOnboard(tmpDir, "unexpected");

    expect(result.status, result.stderr).toBe(0);
    const lastLine = result.stdout.trim().split(/\n/).at(-1) ?? "";
    const payload = JSON.parse(lastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      exitListeners: number;
    };
    expect(payload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(payload.loaded.steps.preflight.status).toBe("failed");
    expect(payload.loaded.status).toBe("failed");
    expect(payload.loaded.failure?.step).toBe("preflight");
    expect(payload.loaded.failure?.message).toBe("Onboarding exited before the step completed.");
    expect(payload.loaded.machine.state).toBe("failed");

    const validationHome = path.join(tmpDir, "validation-home");
    fs.mkdirSync(validationHome);
    const validationResult = runOnboard(validationHome, "validation");

    expect(validationResult.status, validationResult.stderr).toBe(1);
    const validationLastLine = validationResult.stdout.trim().split(/\n/).at(-1) ?? "";
    const validationPayload = JSON.parse(validationLastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      exitListeners: number;
    };
    expect(validationPayload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(validationPayload.loaded.steps.preflight.status).toBe("in_progress");
    expect(validationPayload.loaded.status).toBe("in_progress");
    expect(validationPayload.loaded.failure).toBeNull();
    expect(validationPayload.loaded.machine.state).toBe("init");
    expect(validationPayload.loaded.checkpoint).not.toBeNull();
    expect(validationPayload.loaded.checkpoint?.machineState).toBe("init");

    const cleanupFailureHome = path.join(tmpDir, "validation-cleanup-failure-home");
    fs.mkdirSync(cleanupFailureHome);
    const cleanupFailureResult = runOnboard(cleanupFailureHome, "validation-cleanup-failure");

    expect(cleanupFailureResult.status, cleanupFailureResult.stderr).toBe(1);
    const cleanupFailureLastLine = cleanupFailureResult.stdout.trim().split(/\n/).at(-1) ?? "";
    const cleanupFailurePayload = JSON.parse(cleanupFailureLastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      exitListeners: number;
    };
    expect(cleanupFailurePayload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(cleanupFailurePayload.loaded.steps.preflight.status).toBe("failed");
    expect(cleanupFailurePayload.loaded.status).toBe("failed");
    expect(cleanupFailurePayload.loaded.failure?.step).toBe("preflight");
    expect(cleanupFailurePayload.loaded.machine.state).toBe("failed");

    const resumeResult = runOnboard(validationHome, "resume");

    expect(resumeResult.status, resumeResult.stderr).toBe(0);
    const resumeLastLine = resumeResult.stdout.trim().split(/\n/).at(-1) ?? "";
    const resumePayload = JSON.parse(resumeLastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      resumeEvidence: {
        requested: boolean;
        sessionId: string;
        startingMachineState: string;
        continuedMachineState: string;
      };
      exitListeners: number;
    };
    expect(resumePayload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(resumePayload.resumeEvidence.requested).toBe(true);
    expect(resumePayload.resumeEvidence.sessionId).toBe(validationPayload.loaded.sessionId);
    expect(resumePayload.resumeEvidence.startingMachineState).toBe("init");
    expect(resumePayload.resumeEvidence.continuedMachineState).toBe("preflight");
    expect(resumePayload.loaded.status).toBe("in_progress");
    expect(resumePayload.loaded.failure).toBeNull();
    expect(resumePayload.loaded.machine.state).toBe("preflight");
  });

  it("onboard() preserves a resumable session after a normal incomplete result (#9048)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const scriptPath = path.join(tmpDir, "onboard-exit-completed.cjs");
    const openshellPath = writeSuccessfulOpenShell(tmpDir);
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const initialPhasesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "initial-flow-phases.ts"),
    );
    const corePhasesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "core-flow-phases.ts"),
    );
    const finalPhasesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "final-flow-phases.ts"),
    );
    const resultPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "result.ts"),
    );
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );

    fs.writeFileSync(
      scriptPath,
      `
const initialPhases = require(${initialPhasesPath});
const corePhases = require(${corePhasesPath});
const finalPhases = require(${finalPhasesPath});
const onboardSession = require(${sessionPath});
const { advanceTo, branchTo, completeOnboardMachine } = require(${resultPath});
const exitListeners = [];
const originalOnce = process.once;
const originalExit = process.exit;

process.once = function once(event, listener) {
  if (event === "exit") {
    exitListeners.push(listener);
    return process;
  }
  return originalOnce.call(process, event, listener);
};
process.exit = function exit(code) {
  throw new Error("process.exit:" + String(code));
};

initialPhases.runInitialOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("preflight", { metadata: { state: "init" } }));
  await runtime.applyResult(advanceTo("gateway", { metadata: { state: "preflight" } }));
  await runtime.applyResult(advanceTo("provider_selection", { metadata: { state: "gateway" } }));
  const session = await runtime.session();
  return {
    context: {
      ...context,
      session,
      gpu: null,
      sandboxGpuConfig: { mode: "disabled", hostGpuPlatform: null },
      gpuPassthrough: false,
      requestedGpuPassthrough: false,
      resumeHasResolvedGpuIntent: true,
    },
    session,
  };
};

corePhases.runCoreOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", {
    metadata: { state: "inference" },
    updates: { provider: "nvidia", model: "nemotron-test" },
  }));
  await runtime.applyResult(branchTo("openclaw", {
    metadata: { state: "sandbox" },
    updates: { sandboxName: "complete-seam" },
  }));
  const session = await runtime.session();
  return {
    context: {
      ...context,
      session,
      sandboxName: "complete-seam",
      provider: "nvidia",
      model: "nemotron-test",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
      nimContainer: null,
      webSearchConfig: null,
      webSearchSupported: false,
      selectedMessagingChannels: [],
    },
    session,
  };
};

finalPhases.runFinalOnboardFlowSlice = async ({ runtime }) => {
  await runtime.applyResult(advanceTo("policies", { metadata: { state: "openclaw" } }));
  await runtime.applyResult(advanceTo("finalizing", { metadata: { state: "policies" } }));
  await runtime.applyResult(advanceTo("post_verify", { metadata: { state: "finalizing" } }));
  if (process.env.NEMOCLAW_TEST_FINAL_STATE === "complete") {
    await runtime.applyResult(completeOnboardMachine(
      { sandboxName: "complete-seam", provider: "nvidia", model: "nemotron-test" },
      { state: "post_verify" },
    ));
  }
  return { context: null, session: await runtime.session() };
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    process.exitCode = 1;
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "complete-seam",
    });
    if (exitListeners.length === 0) throw new Error("missing exit handler");
    for (const exitHandler of exitListeners) exitHandler(1);
    const loaded = onboardSession.loadSession();
    console.log(JSON.stringify({ loaded, exitListeners: exitListeners.length }));
  } finally {
    process.once = originalOnce;
    process.exit = originalExit;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`,
    );

    const runOnboard = (home: string, finalState: "complete" | "incomplete") =>
      spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: ONBOARD_FIXTURE_PATH,
          TMPDIR: tmpDir,
          NEMOCLAW_TEST_FINAL_STATE: finalState,
          NEMOCLAW_TEST_NO_SLEEP: "1",
          NEMOCLAW_OPENSHELL_BIN: openshellPath,
        },
        timeout: 60_000,
      });

    const result = runOnboard(tmpDir, "complete");

    expect(result.status, result.stderr).toBe(0);
    const lastLine = result.stdout.trim().split(/\n/).at(-1) ?? "";
    const payload = JSON.parse(lastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      exitListeners: number;
    };
    expect(payload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(payload.loaded.status).toBe("complete");
    expect(payload.loaded.failure).toBeNull();
    expect(payload.loaded.sandboxName).toBe("complete-seam");
    expect(payload.loaded.machine.state).toBe("complete");

    const incompleteHome = path.join(tmpDir, "incomplete-home");
    fs.mkdirSync(incompleteHome);
    const incompleteResult = runOnboard(incompleteHome, "incomplete");

    expect(incompleteResult.status, incompleteResult.stderr).toBe(1);
    const incompleteLastLine = incompleteResult.stdout.trim().split(/\n/).at(-1) ?? "";
    const incompletePayload = JSON.parse(incompleteLastLine) as {
      loaded: ReturnType<typeof onboardSession.createSession>;
      exitListeners: number;
    };
    expect(incompletePayload.exitListeners).toBeGreaterThanOrEqual(2);
    expect(incompletePayload.loaded.status).toBe("in_progress");
    expect(incompletePayload.loaded.failure).toBeNull();
    expect(incompletePayload.loaded.machine.state).toBe("post_verify");
  });
});
