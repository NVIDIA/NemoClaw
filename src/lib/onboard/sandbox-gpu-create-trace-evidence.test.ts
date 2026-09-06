// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
  addTraceEvent: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

vi.mock("./sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-readiness-tracing")>()),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));

vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));

vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));

vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));

vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));

vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

vi.mock("./tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tracing")>()),
  addTraceEvent: mocks.addTraceEvent,
}));

import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
} from "../adapters/openshell/sandbox-identity";
import { resetTraceForTests, TRACE_FILE_ENV } from "../trace";
import {
  createGpuFlowDeps,
  createGpuFlowInput,
  createGpuPatchFixture,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";
import { finishOnboardTrace, startOnboardTrace, withSandboxPhaseTrace } from "./tracing";

const SANDBOX_ID_FINGERPRINT = "8174fa2a5d65755138d8339e086c03d736633130b22dca10952e80e74750c01d";
const SANDBOX_ID_CORRELATION = SANDBOX_ID_FINGERPRINT.slice(0, 16);

type FlowDependencies = ReturnType<typeof createGpuFlowDeps>;
type Flow = ReturnType<typeof runSandboxGpuCreateFlow>;
type CreateResult = {
  status: number;
  output: string;
  sawProgress: boolean;
  readyTerminationTimedOut?: boolean;
};
type TraceEvidenceScenario = {
  title: string;
  completed: boolean;
  operationState: "create_client_exited" | "ready";
  identityState: "failed" | "matched";
  expectedCorrelation: string | null;
  expectedLifecycleEvents: readonly string[];
  createResult: CreateResult;
  exerciseReadyCheck: (readyCheck: (() => boolean) | undefined) => void;
  configureIdentityObservations: (
    deps: FlowDependencies,
    currentNonce: () => string,
    lifecycleEvents: string[],
  ) => void;
  expectFlow: (flow: Flow) => Promise<void>;
};

function sandboxListJson(nonce: string): string {
  return JSON.stringify([
    {
      id: "alpha-sandbox-id",
      name: "alpha",
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
    },
  ]);
}

function createAttemptNonce(args: readonly string[]): string {
  const labelIndex = args.indexOf("--label");
  return (args[labelIndex + 1] ?? "").slice(NEMOCLAW_CREATE_ATTEMPT_LABEL.length + 1);
}

function noGpuInput() {
  const input = createGpuFlowInput();
  input.sandboxGpuConfig = {
    mode: "0",
    hostGpuDetected: false,
    hostGpuPlatform: null,
    sandboxGpuEnabled: false,
    sandboxGpuDevice: null,
    errors: [],
  };
  input.gpuRoutePlan = "none";
  input.initialGpuRoute = "none";
  input.createArgv = ["openshell", "sandbox", "create", "--name", "alpha", "--", "agent"];
  input.persistRetainedSandboxRecovery = vi.fn(() => true);
  input.verifyCreatedSandboxBeforeEffects = vi.fn();
  input.revalidateVerifiedSandboxBeforeEffect = vi.fn();
  return input;
}

const SUCCESSFUL_CREATE = {
  status: 0,
  output: "Created sandbox: alpha",
  sawProgress: true,
} as const;
const TIMED_OUT_CREATE = {
  status: 1,
  output: "OpenShell create client did not exit after Ready; aborting cutover.",
  sawProgress: true,
  readyTerminationTimedOut: true,
} as const;
const OBSERVE_READY = (readyCheck: (() => boolean) | undefined): void => {
  expect(readyCheck?.()).toBe(true);
};
const SKIP_READY_OBSERVATION = (): void => {};

const TRACE_EVIDENCE_SCENARIOS: readonly TraceEvidenceScenario[] = [
  {
    title: "matched identity",
    completed: true,
    operationState: "ready",
    identityState: "matched",
    expectedCorrelation: SANDBOX_ID_CORRELATION,
    expectedLifecycleEvents: ["identity-settled", "verify-created"],
    createResult: SUCCESSFUL_CREATE,
    exerciseReadyCheck: OBSERVE_READY,
    configureIdentityObservations: (deps, currentNonce, lifecycleEvents) => {
      vi.mocked(deps.runCaptureOpenshell)
        .mockReturnValueOnce("alpha Ready")
        .mockReturnValueOnce("[]")
        .mockImplementationOnce(() => {
          lifecycleEvents.push("identity-settled");
          return sandboxListJson(currentNonce());
        });
    },
    expectFlow: async (flow) => {
      await expect(flow).resolves.toMatchObject({ route: "none" });
    },
  },
  {
    title: "failed settlement before identity publication",
    completed: false,
    operationState: "ready",
    identityState: "failed",
    expectedCorrelation: null,
    expectedLifecycleEvents: [],
    createResult: SUCCESSFUL_CREATE,
    exerciseReadyCheck: OBSERVE_READY,
    configureIdentityObservations: (deps) => {
      vi.mocked(deps.runCaptureOpenshell).mockReturnValueOnce("alpha Ready").mockReturnValue("[]");
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(30_000);
    },
    expectFlow: async (flow) => {
      await expect(flow).rejects.toThrow(
        "did not return one exact durable sandbox identity before post-create effects",
      );
    },
  },
  {
    title: "failed Ready handoff termination with an observed identity",
    completed: false,
    operationState: "ready",
    identityState: "failed",
    expectedCorrelation: SANDBOX_ID_CORRELATION,
    expectedLifecycleEvents: [],
    createResult: TIMED_OUT_CREATE,
    exerciseReadyCheck: OBSERVE_READY,
    configureIdentityObservations: (deps, currentNonce) => {
      vi.mocked(deps.runCaptureOpenshell)
        .mockReturnValueOnce("alpha Ready")
        .mockImplementationOnce(() => sandboxListJson(currentNonce()));
    },
    expectFlow: async (flow) => {
      await expect(flow).rejects.toThrow("OpenShell create client did not exit after Ready");
    },
  },
  {
    title: "matched identity after the create client exits without a Ready observation",
    completed: true,
    operationState: "create_client_exited",
    identityState: "matched",
    expectedCorrelation: SANDBOX_ID_CORRELATION,
    expectedLifecycleEvents: ["identity-settled", "verify-created"],
    createResult: SUCCESSFUL_CREATE,
    exerciseReadyCheck: SKIP_READY_OBSERVATION,
    configureIdentityObservations: (deps, currentNonce, lifecycleEvents) => {
      vi.mocked(deps.runCaptureOpenshell).mockImplementationOnce(() => {
        lifecycleEvents.push("identity-settled");
        return sandboxListJson(currentNonce());
      });
    },
    expectFlow: async (flow) => {
      await expect(flow).resolves.toMatchObject({ route: "none" });
    },
  },
];

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(() => {
  delete process.env[TRACE_FILE_ENV];
  resetTraceForTests();
  resetGpuFlowMocks();
});

describe("sandbox create trace evidence", () => {
  it.each(TRACE_EVIDENCE_SCENARIOS)(
    "retains real create-runner settlement evidence through trace sanitization: $title",
    async (scenario) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-identity-trace-evidence-"));
      const traceFile = path.join(directory, "raw-trace.json");
      const outputDirectory = path.join(directory, "trusted");
      try {
        process.env[TRACE_FILE_ENV] = traceFile;
        resetTraceForTests();
        const actualTracing = await vi.importActual<typeof import("./tracing")>("./tracing");
        mocks.addTraceEvent.mockImplementation(actualTracing.addTraceEvent);

        let nonce = "";
        const lifecycleEvents: string[] = [];
        const input = noGpuInput();
        input.verifyCreatedSandboxBeforeEffects = vi.fn(() => {
          lifecycleEvents.push("verify-created");
        });
        const patch = createGpuPatchFixture();
        mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(patch);
        mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
          nonce = createAttemptNonce(args);
          expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
          scenario.exerciseReadyCheck(options.readyCheck);
          return scenario.createResult;
        });
        const deps = createGpuFlowDeps();
        deps.installPortableDemoLifecycle = vi.fn();
        scenario.configureIdentityObservations(deps, () => nonce, lifecycleEvents);

        const trace = startOnboardTrace({ fresh: true }, process.env);
        try {
          const flow = withSandboxPhaseTrace("alpha", "nim", "mock", "openclaw", () =>
            runSandboxGpuCreateFlow(input, deps),
          );
          await scenario.expectFlow(flow);
        } finally {
          finishOnboardTrace(trace, scenario.completed);
        }

        const sanitizer = spawnSync(
          "python3",
          ["scripts/e2e/sanitize-trace-timing.py", traceFile, outputDirectory],
          { cwd: process.cwd(), encoding: "utf8" },
        );
        expect(sanitizer.status, sanitizer.stderr).toBe(0);
        const rawTrace = fs.readFileSync(traceFile, "utf8");
        const summary = fs.readFileSync(
          path.join(outputDirectory, "cloud-onboard-trace-timing-summary.json"),
          "utf8",
        );

        expect(JSON.parse(summary)).toMatchObject({
          sandbox_identity_settlement: {
            create_operation_state: scenario.operationState,
            event_time_unix_nano: expect.stringMatching(/^[1-9][0-9]{15,20}$/u),
            identity_state: scenario.identityState,
            returned_identity_correlation: scenario.expectedCorrelation,
            trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
          },
        });
        expect(lifecycleEvents).toEqual(scenario.expectedLifecycleEvents);
        expect(rawTrace).not.toContain("alpha-sandbox-id");
        expect(rawTrace).not.toContain(SANDBOX_ID_FINGERPRINT);
        expect(summary).not.toContain("alpha-sandbox-id");
        expect(summary).not.toContain(SANDBOX_ID_FINGERPRINT);
      } finally {
        delete process.env[TRACE_FILE_ENV];
        resetTraceForTests();
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
