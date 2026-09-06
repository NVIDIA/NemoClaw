// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(() => {
  delete process.env[TRACE_FILE_ENV];
  resetTraceForTests();
  resetGpuFlowMocks();
});

describe("sandbox create trace evidence", () => {
  it("retains delayed Ready identity settlement through real trace sanitization", async () => {
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
      mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(createGpuPatchFixture());
      mocks.streamSandboxCreate.mockImplementation(async (_command, args, _env, options) => {
        nonce = createAttemptNonce(args);
        expect(nonce).toHaveLength(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
        expect(options.readyCheck?.()).toBe(true);
        lifecycleEvents.push("create-client-closed");
        return { status: 0, output: "Created sandbox: alpha", sawProgress: true };
      });
      const deps = createGpuFlowDeps();
      deps.installPortableDemoLifecycle = vi.fn();
      vi.mocked(deps.runCaptureOpenshell)
        .mockReturnValueOnce("alpha Ready")
        .mockReturnValueOnce("[]")
        .mockImplementationOnce(() => {
          lifecycleEvents.push("identity-settled");
          return sandboxListJson(nonce);
        });

      const trace = startOnboardTrace({ fresh: true }, process.env);
      try {
        await expect(
          withSandboxPhaseTrace("alpha", "nim", "mock", "openclaw", () =>
            runSandboxGpuCreateFlow(input, deps),
          ),
        ).resolves.toMatchObject({ route: "none" });
      } finally {
        finishOnboardTrace(trace, true);
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
          create_operation_state: "ready",
          event_time_unix_nano: expect.stringMatching(/^[1-9][0-9]{15,20}$/u),
          identity_state: "matched",
          returned_identity_correlation: SANDBOX_ID_CORRELATION,
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
        },
      });
      expect(lifecycleEvents).toEqual([
        "create-client-closed",
        "identity-settled",
        "verify-created",
      ]);
      expect(rawTrace).not.toContain("alpha-sandbox-id");
      expect(rawTrace).not.toContain(SANDBOX_ID_FINGERPRINT);
      expect(summary).not.toContain("alpha-sandbox-id");
      expect(summary).not.toContain(SANDBOX_ID_FINGERPRINT);
    } finally {
      delete process.env[TRACE_FILE_ENV];
      resetTraceForTests();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
