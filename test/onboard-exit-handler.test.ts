// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

type OnboardModule = typeof import("../src/lib/onboard") & {
  onboardSession: typeof import("../src/lib/state/onboard-session");
  registerIncompleteOnboardExitHandlerForSession: (
    deps: typeof import("../src/lib/state/onboard-session"),
    isComplete: () => boolean,
    processLike: { once(event: "exit", listener: (code: number) => void): unknown },
  ) => void;
};

const require = createRequire(import.meta.url);
const onboard = require("../src/lib/onboard.js") as OnboardModule;
const onboardSession = onboard.onboardSession;
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

  it("onboard() registers incomplete nonzero exit handling after bootstrap", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const scriptPath = path.join(tmpDir, "onboard-exit-registration.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const flowSlicesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "machine", "flow-slices.ts"),
    );
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );

    fs.writeFileSync(
      scriptPath,
      `
const flowSlices = require(${flowSlicesPath});
const onboardSession = require(${sessionPath});
const sentinel = new Error("stop-after-exit-registration");
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

flowSlices.runInitialOnboardFlowSequence = async ({ runtime }) => {
  await runtime.markStepStarted("preflight");
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
    if (error !== sentinel && error?.message !== sentinel.message) {
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

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpDir,
        TMPDIR: tmpDir,
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
      timeout: 60_000,
    });

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
  });

  it("authoritative onboard restores target-scoped state on an early failure", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const scriptPath = path.join(tmpDir, "authoritative-onboard-early-cleanup.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const brandingPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "branding.ts"),
    );

    fs.writeFileSync(
      scriptPath,
      `
const branding = require(${brandingPath});
const { onboard } = require(${onboardPath});
const originalExit = process.exit;
const sentinels = {
  OPENSHELL_GATEWAY: "before-gateway",
  OPENSHELL_LOCAL_TLS_DIR: "before-tls",
  NEMOCLAW_POLICY_TIER: "standard",
  NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "before-network",
  NEMOCLAW_HERMES_DASHBOARD: "before-enabled",
  NEMOCLAW_HERMES_DASHBOARD_PORT: "19191",
  NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "29191",
  NEMOCLAW_HERMES_DASHBOARD_TUI: "before-tui",
};
Object.assign(process.env, sentinels);
branding.setOnboardBrandingAgent("openclaw");
process.exit = function exit(code) {
  throw new Error("process.exit:" + String(code));
};

(async () => {
  let failure = null;
  try {
    await onboard({
      agent: "hermes",
      autoYes: true,
      authoritativeCustomPolicies: [],
      authoritativeDockerGpuPatchNetwork: "preserve",
      authoritativeHermesDashboardConfig: {
        enabled: true,
        port: 9119,
        internalPort: 19119,
        tuiEnabled: true,
      },
      authoritativeInitialPolicy: { policyPath: "/tmp/not-used.yaml", appliedPresets: [] },
      authoritativeMessagingPrevalidated: true,
      authoritativeMessagingReuse: {
        providers: [], channels: [], disabledChannels: [], detachProviders: [],
        extraProviders: [], extraPlaceholderKeys: [],
      },
      authoritativePolicyTier: "restricted",
      authoritativeResourceProfile: null,
      authoritativeResumeConfig: true,
      authoritativeRuntimePreflight: {
        gpu: null,
        host: { dockerReachable: true, runtime: "docker", notes: [] },
        sandboxGpuConfig: {
          mode: "0", hostGpuDetected: false, hostGpuPlatform: null,
          sandboxGpuEnabled: false, sandboxGpuDevice: null, errors: [],
        },
      },
      controlUiPort: null,
      nonInteractive: true,
      onboardLockAlreadyHeld: true,
      recreateSandbox: true,
      resume: true,
      sandboxName: "alpha",
      targetGatewayName: "nemoclaw",
      targetGatewayPort: 8080,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    process.exit = originalExit;
  }
  console.log(JSON.stringify({
    branding: branding.getOnboardBrandingAgent(),
    env: Object.fromEntries(Object.keys(sentinels).map((name) => [name, process.env[name]])),
    failure,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpDir,
        TMPDIR: tmpDir,
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1) ?? "") as {
      branding: string | null;
      env: Record<string, string>;
      failure: string | null;
    };
    expect(payload.failure).toBe("process.exit:1");
    expect(payload.branding).toBe("openclaw");
    expect(payload.env).toEqual({
      OPENSHELL_GATEWAY: "before-gateway",
      OPENSHELL_LOCAL_TLS_DIR: "before-tls",
      NEMOCLAW_POLICY_TIER: "standard",
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "before-network",
      NEMOCLAW_HERMES_DASHBOARD: "before-enabled",
      NEMOCLAW_HERMES_DASHBOARD_PORT: "19191",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "29191",
      NEMOCLAW_HERMES_DASHBOARD_TUI: "before-tui",
    });
  });

  it("onboard() does not mark a completed session failed on later nonzero exit", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const scriptPath = path.join(tmpDir, "onboard-exit-completed.cjs");
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
  await runtime.applyResult(completeOnboardMachine(
    { sandboxName: "complete-seam", provider: "nvidia", model: "nemotron-test" },
    { state: "post_verify" },
  ));
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({
      nonInteractive: true,
      autoYes: true,
      acceptThirdPartySoftware: true,
      noGpu: true,
      sandboxName: "complete-seam",
    });
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

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpDir,
        TMPDIR: tmpDir,
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
      timeout: 60_000,
    });

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
  });
});
