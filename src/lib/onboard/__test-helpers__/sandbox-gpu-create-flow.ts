// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { SandboxGpuProofResult } from "../../state/registry";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "../sandbox-gpu-create-flow";

export const VERIFIED_GPU_PROOF: SandboxGpuProofResult = {
  status: "verified",
  cudaVerified: true,
  label: "CUDA initialization",
  detail: null,
  at: "2026-07-06T00:00:00.000Z",
};
export const GPU_IMAGE_ID = `sha256:${"a".repeat(64)}`;

export function createGpuFlowInput(): SandboxGpuCreateFlowInput {
  return {
    sandboxName: "alpha",
    provider: "nim",
    sandboxGpuConfig: {
      mode: "1",
      hostGpuDetected: true,
      hostGpuPlatform: null,
      sandboxGpuEnabled: true,
      sandboxGpuDevice: null,
      errors: [],
    },
    gpuRoutePlan: "native-with-fallback",
    initialGpuRoute: "native",
    compatibilityPolicyPath: "/tmp/compatibility-policy.yaml",
    dockerDriverGateway: true,
    gatewayPort: 8080,
    sandboxReadyTimeoutSecs: 60,
    createArgv: ["openshell", "sandbox", "create", "--gpu"],
    sandboxEnv: {},
    sandboxStartupCommand: ["nemoclaw-start"],
    prebuild: {
      createArgs: ["--from", "openshell/sandbox-from:test", "--name", "alpha", "--gpu"],
      imageRef: "openshell/sandbox-from:test",
      imageId: GPU_IMAGE_ID,
    },
    restoreBackupPath: null,
    terminalAgent: false,
  };
}

export function createGpuFlowDeps(): SandboxGpuCreateFlowDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn(() => "alpha Ready"),
    sleep: vi.fn(),
    openshellArgv: vi.fn((args: string[]) => ["openshell", ...args]),
    verifyDirectSandboxGpu: vi.fn(() => VERIFIED_GPU_PROOF),
  };
}

export function createGpuPatchFixture() {
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(),
    ensureApplied: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    selectedMode: vi.fn(() => null),
    printReadinessFailureIfEnabled: vi.fn(),
    verifyGpuOrExit: vi.fn(() => VERIFIED_GPU_PROOF),
  };
}

export function setupGpuFlowMocks(mocks: Record<string, ReturnType<typeof vi.fn>>): void {
  mocks.streamSandboxCreate.mockResolvedValue({
    status: 0,
    output: "Created sandbox: alpha",
    sawProgress: true,
  });
  mocks.createDockerGpuSandboxCreatePatch.mockImplementation(createGpuPatchFixture);
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: true,
    reason: "ready",
    failurePhase: null,
  });
  mocks.verifyGpuSandboxAccessAfterReady.mockImplementation((_config, options) =>
    options.verifyGpuOrExit
      ? options.verifyGpuOrExit(options.verifyDirectSandboxGpu)
      : options.verifyDirectSandboxGpu(options.sandboxName),
  );
  mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
  mocks.collectDockerGpuPatchDiagnostics.mockReturnValue(null);
  mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({ ok: true, ids: [] });
  mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
    ok: true,
    imageId: GPU_IMAGE_ID,
    bookkeepingImageRef: "openshell/sandbox-from:test",
    stateError: "",
    nativeGpuAttachmentState: "present",
    containerId: "container-a",
  });
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

export function resetGpuFlowMocks(): void {
  vi.restoreAllMocks();
  vi.clearAllMocks();
}
