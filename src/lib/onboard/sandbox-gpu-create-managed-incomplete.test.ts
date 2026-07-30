// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDockerGpuSandboxCreatePatch: vi.fn(),
  isDockerDesktopWslRuntime: vi.fn(() => false),
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
  isDockerDesktopWslRuntime: mocks.isDockerDesktopWslRuntime,
}));

vi.mock("./sandbox-readiness-tracing", () => ({
  printReadinessFailure: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
}));

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type {
  ManagedBootstrapAdapter,
  ManagedBootstrapCompletionReceipt,
  ManagedBootstrapFinalizationReceipt,
  ManagedBootstrapHeldWorkloadHandle,
  ManagedBootstrapObservedSnapshot,
  ManagedBootstrapReplacementHandle,
} from "./managed-bootstrap/adapter";
import {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  renderManagedBootstrapHeldCommand,
} from "./managed-bootstrap/adapter";
import type { ManagedBootstrapRuntimeProvider } from "./managed-bootstrap/runtime-provider";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import {
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowDeps,
  type SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";

const BOOTSTRAP_IDENTITY = "1".repeat(64);
const RUNTIME_ID = "2".repeat(64);
const REPLACEMENT_ID = "3".repeat(64);
const IMAGE_CONTENT_ID = `sha256:${"4".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"5".repeat(64)}` as const;
const SPEC_HASH = "6".repeat(64);
const REPLACEMENT_SPEC_HASH = "7".repeat(64);
const SANDBOX_ID = "sandbox-alpha";
const NOW = "2026-07-30T08:00:00.000Z";

const request = createManagedStartupRootApplyRequest({
  agent: "hermes",
  encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("hermes", false, false)),
});
const intendedWorkloadArgv = ["env", "nemoclaw-start"] as const;
const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
  request,
  BOOTSTRAP_IDENTITY,
  intendedWorkloadArgv,
);

function finalizationReceipt(outcome: "commit" | "rollback"): ManagedBootstrapFinalizationReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: {
      sandboxName: "alpha",
      sandboxId: SANDBOX_ID,
      driverId: "docker",
    },
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    outcome: outcome === "commit" ? "committed" : "rolled-back",
    restoredRuntimeId: null,
    restoredSpecHash: null,
    heldWorkloadRemoved: outcome === "rollback",
    alreadyRolledBack: false,
    finalizedAt: NOW,
  };
}

function createAdapterFixture() {
  let ownedWorkloadPresent = true;
  const adapter: ManagedBootstrapAdapter = {
    createHeldWorkload: vi.fn(async (input): Promise<ManagedBootstrapHeldWorkloadHandle> => {
      const createReceipt = await input.launch({
        heldWorkloadArgv,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
      });
      return {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: createReceipt.sandbox,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        heldWorkloadArgv,
        intendedWorkloadArgv,
        plan: input.plan,
        createReceipt,
      };
    }),
    cleanupIncompleteCreate: vi.fn(async () => {
      ownedWorkloadPresent = false;
      return finalizationReceipt("rollback");
    }),
    discoverHeldWorkload: vi.fn(async (input) => ({
      sandbox: input.sandbox,
      runtimeId: RUNTIME_ID,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
    })),
    inspectHeldWorkload: vi.fn(
      async ({ handle }): Promise<ManagedBootstrapObservedSnapshot> => ({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: RUNTIME_ID,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        image: handle.plan.image,
        runtimeImageContentId: IMAGE_CONTENT_ID,
        specHash: SPEC_HASH,
        specCanonicalJson: "{}",
        agentIdentity: handle.plan.agentIdentity,
        supervisorArgv: handle.plan.expectedSupervisorArgv,
        heldWorkloadArgv,
        metadata: handle.plan.metadata,
      }),
    ),
    replaceForBootstrap: vi.fn(
      async ({ handle, snapshot }): Promise<ManagedBootstrapReplacementHandle> => ({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        originalRuntimeId: RUNTIME_ID,
        replacementRuntimeId: REPLACEMENT_ID,
        image: snapshot.image,
        runtimeImageContentId: IMAGE_CONTENT_ID,
        originalSpecHash: SPEC_HASH,
        replacementSpecHash: REPLACEMENT_SPEC_HASH,
        profileFingerprint: request.profileFingerprint,
      }),
    ),
    awaitBootstrap: vi.fn(
      async ({ handle }): Promise<ManagedBootstrapCompletionReceipt> => ({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: REPLACEMENT_ID,
        image: handle.plan.image,
        runtimeImageContentId: IMAGE_CONTENT_ID,
        originalSpecHash: SPEC_HASH,
        replacementSpecHash: REPLACEMENT_SPEC_HASH,
        profileFingerprint: request.profileFingerprint,
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        transactionPending: false,
        completedAt: NOW,
      }),
    ),
    finalizeBootstrap: vi.fn(async ({ outcome }) => finalizationReceipt(outcome)),
  };
  return {
    adapter,
    get ownedWorkloadPresent() {
      return ownedWorkloadPresent;
    },
  };
}

function createPatchFixture() {
  let cutover:
    | {
        readonly rollback: () => Promise<void>;
        readonly commit: () => Promise<void>;
      }
    | undefined;
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(),
    rollbackManagedStartupAfterCreateFailure: vi.fn(async () => cutover?.rollback()),
    ensureApplied: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    commitAfterReady: vi.fn(async () => cutover?.commit()),
    selectedMode: vi.fn(() => null),
    printReadinessFailureIfEnabled: vi.fn(),
    verifyGpuOrExit: vi.fn(),
    attachManagedBootstrapCutover: vi.fn(
      (value: { readonly rollback: () => Promise<void>; readonly commit: () => Promise<void> }) => {
        cutover = value;
      },
    ),
  };
}

function createFlowFixture(options: {
  readonly adapter: ManagedBootstrapAdapter;
  readonly listOutput?: string;
  readonly getOutput?: string;
}) {
  const runtimeProvider: ManagedBootstrapRuntimeProvider = {
    driverId: "docker",
    createAdapter: vi.fn(() => options.adapter),
    createReplacementOptions: vi.fn(() => ({ values: {} })),
  };
  const input: SandboxGpuCreateFlowInput = {
    sandboxName: "alpha",
    provider: "nim",
    sandboxGpuConfig: {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    gpuRoutePlan: "none",
    initialGpuRoute: "none",
    compatibilityPolicyPath: null,
    dockerDriverGateway: true,
    gatewayPort: 8080,
    sandboxReadyTimeoutSecs: 30,
    createArgv: ["openshell", "sandbox", "create", "--name", "alpha"],
    sandboxEnv: {},
    sandboxStartupCommand: [...heldWorkloadArgv],
    prebuild: {
      createArgs: ["--name", "alpha"],
      imageRef: "registry.example/nemoclaw/hermes:test",
      imageId: IMAGE_CONTENT_ID,
    },
    restoreBackupPath: null,
    terminalAgent: false,
    managedBootstrap: {
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      runtimeProvider,
      request,
      image: {
        repository: "registry.example/nemoclaw/hermes",
        manifestDigest: MANIFEST_DIGEST,
      },
      agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
      intendedWorkloadArgv,
      expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox"],
    },
  };
  const deps: SandboxGpuCreateFlowDeps = {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn((args) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return options.getOutput ?? `Name: alpha\nID: ${SANDBOX_ID}\n`;
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return options.listOutput ?? "alpha Ready\n";
      }
      return "";
    }),
    sleep: vi.fn(),
    openshellArgv: vi.fn((args) => ["openshell", ...args]),
    verifyDirectSandboxGpu: vi.fn(),
  };
  return { deps, input, runtimeProvider };
}

beforeEach(() => {
  mocks.createDockerGpuSandboxCreatePatch.mockImplementation(createPatchFixture);
  mocks.streamSandboxCreate.mockResolvedValue({
    status: 0,
    output: "Created sandbox: alpha",
    sawProgress: true,
  });
  mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue({
    ready: true,
    reason: "ready",
    failurePhase: null,
  });
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("managed bootstrap incomplete create recovery", () => {
  it("continues the same managed bootstrap sequence after nonzero create reaches Ready", async () => {
    mocks.streamSandboxCreate.mockResolvedValue({
      status: 17,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
    const fixture = createAdapterFixture();
    const { deps, input } = createFlowFixture({ adapter: fixture.adapter });

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      createResult: { status: 17 },
      route: "none",
    });

    expect(mocks.waitForCreatedSandboxReadyWithTrace).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.createHeldWorkload).toHaveBeenCalledOnce();
    expect(fixture.adapter.discoverHeldWorkload).toHaveBeenCalledOnce();
    expect(fixture.adapter.inspectHeldWorkload).toHaveBeenCalledOnce();
    expect(fixture.adapter.replaceForBootstrap).toHaveBeenCalledOnce();
    expect(fixture.adapter.awaitBootstrap).toHaveBeenCalledOnce();
    expect(fixture.adapter.cleanupIncompleteCreate).not.toHaveBeenCalled();
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "commit" }),
    );
    expect(fixture.ownedWorkloadPresent).toBe(true);
  });

  it.each([
    {
      label: "nonzero incomplete create never reaches Ready",
      createResult: { status: 17, output: "Created sandbox: alpha", sawProgress: true },
      listOutput: "alpha Pending\n",
      getOutput: `Name: alpha\nID: ${SANDBOX_ID}\n`,
      readiness: { ready: false, reason: "timeout", failurePhase: null },
      error: "did not reach authoritative Ready state",
    },
    {
      label: "zero create is not authoritatively Ready",
      createResult: { status: 0, output: "Created sandbox: alpha", sawProgress: true },
      listOutput: "alpha Pending\n",
      getOutput: `Name: alpha\nID: ${SANDBOX_ID}\n`,
      readiness: { ready: true, reason: "ready", failurePhase: null },
      error: "without an authoritative Ready sandbox",
    },
    {
      label: "zero create has no exact durable identity",
      createResult: { status: 0, output: "Created sandbox: alpha", sawProgress: true },
      listOutput: "alpha Ready\n",
      getOutput: "Name: alpha\n",
      readiness: { ready: true, reason: "ready", failurePhase: null },
      error: "did not return one exact durable sandbox identity",
    },
  ])("fails closed and removes the exact pre-handle workload when $label", async (scenario) => {
    mocks.streamSandboxCreate.mockResolvedValue(scenario.createResult);
    mocks.waitForCreatedSandboxReadyWithTrace.mockReturnValue(scenario.readiness);
    const fixture = createAdapterFixture();
    const { deps, input } = createFlowFixture({
      adapter: fixture.adapter,
      listOutput: scenario.listOutput,
      getOutput: scenario.getOutput,
    });

    await expect(runSandboxGpuCreateFlow(input, deps)).rejects.toThrow(scenario.error);

    expect(fixture.adapter.cleanupIncompleteCreate).toHaveBeenCalledOnce();
    expect(fixture.adapter.discoverHeldWorkload).not.toHaveBeenCalled();
    expect(fixture.adapter.inspectHeldWorkload).not.toHaveBeenCalled();
    expect(fixture.adapter.replaceForBootstrap).not.toHaveBeenCalled();
    expect(fixture.adapter.awaitBootstrap).not.toHaveBeenCalled();
    expect(fixture.ownedWorkloadPresent).toBe(false);
    const patch = mocks.createDockerGpuSandboxCreatePatch.mock.results[0]?.value;
    expect(patch?.ensureApplied).not.toHaveBeenCalled();
  });
});
