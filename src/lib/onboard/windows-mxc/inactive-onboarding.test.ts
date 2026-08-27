// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";

const nativeBoundary = vi.hoisted(() => ({
  observeFileDigest: vi.fn<(filePath: string) => Promise<string>>(),
  observeHostFacts: vi.fn(),
}));

vi.mock("../runtime-provider/mxc-windows-file-observer", () => ({
  createMxcWindowsOpenShellFileDigestObserver: () => nativeBoundary.observeFileDigest,
}));

vi.mock("./native-host-facts", () => ({
  observeWindowsMxcNativeHostFacts: nativeBoundary.observeHostFacts,
}));

import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../runtime-provider/current";
import type { MxcNativeArtifactControlPlane } from "../runtime-provider/mxc-bootstrap-operations";
import { mxcOpenShellAttachmentFixture } from "../runtime-provider/mxc-openshell-attachment-test-fixture";
import { MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION } from "../runtime-provider/mxc-openshell-attachment";
import type { MxcOpenShellAttachmentObservationRequest } from "../runtime-provider/mxc-openshell-observer";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import {
  recoverMxcWindowsInactiveOnboarding,
  runMxcWindowsInactiveOnboarding,
  type MxcWindowsInactiveOnboardingInput,
} from "./inactive-onboarding";

const REQUIRED_ENVIRONMENT = [
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

function controlPlane(): MxcNativeArtifactControlPlane {
  return {
    contractVersion: 1,
    providerId: "mxc",
    verifyAndCreate: vi.fn(async (plan) => ({
      status: "created" as const,
      authoritySha256: plan.authoritySha256,
      providerHandle: plan.providerHandle,
      sandboxName: plan.sandboxName,
      lifecycleGeneration: plan.lifecycleGeneration,
      artifactDigest: plan.workload.artifact.digest,
      executableDigest: plan.workload.launch.executable.digest,
    })),
    verifyReadiness: vi.fn(async (plan) => ({
      authoritySha256: plan.authoritySha256,
      providerHandle: plan.providerHandle,
      sandboxName: plan.sandboxName,
      lifecycleGeneration: plan.lifecycleGeneration,
      artifactDigest: plan.workload.artifact.digest,
      executableDigest: plan.workload.launch.executable.digest,
      ready: true as const,
    })),
    recoverCreate: vi.fn(async () => ({ status: "absent" as const })),
  };
}

function observationRequest(): MxcOpenShellAttachmentObservationRequest {
  const observed = mxcOpenShellAttachmentFixture("0.0.24").observation;
  return {
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: "mxc",
    mode: "attach-existing",
    observedDistribution: {
      version: observed.distribution.version,
      revision: observed.distribution.revision,
    },
    observedGateway: { driver: "mxc", backend: "process_container" },
    installation: {
      distributionArtifactPath: "C:\\OpenShell\\packages\\openshell-0.0.24.zip",
      distributionRoot: observed.distributionRoot,
      mxcRoot: observed.mxcRoot,
      cliPath: observed.cliPath,
      gatewayPath: observed.gatewayPath,
      wxcExecPath: observed.wxcExecPath,
      gatewayConfigPath: observed.gatewayConfigPath,
    },
  };
}

function acceptedDigests(): Map<string, string> {
  const observed = mxcOpenShellAttachmentFixture("0.0.24").observation;
  return new Map([
    ["C:\\OpenShell\\packages\\openshell-0.0.24.zip", observed.distribution.sha256],
    [observed.cliPath, observed.components.cliSha256],
    [observed.gatewayPath, observed.components.gatewaySha256],
    [observed.wxcExecPath, observed.components.wxcExecSha256],
    [observed.gatewayConfigPath, observed.gateway.configSha256],
  ]);
}

function onboardingInput(
  bootstrapControlPlane: MxcNativeArtifactControlPlane,
): MxcWindowsInactiveOnboardingInput {
  const attachment = mxcOpenShellAttachmentFixture("0.0.24");
  const workload = nativeArtifactWorkloadReceiptFixture(
    encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
  );
  return {
    installation: {
      openshellAttachmentAuthority: attachment.authority,
      attachmentObservation: observationRequest(),
      bootstrapControlPlane,
    },
    bootstrap: {
      sandboxName: "openclaw-mxc",
      lifecycleGeneration: "generation-1",
      driveRoot: "C:\\",
      artifactRoot: "C:\\openclaw-artifact",
      workload: {
        ...workload,
        launch: { ...workload.launch, environmentNames: REQUIRED_ENVIRONMENT },
      },
    },
  };
}

describe("inactive native Windows OpenShell MXC onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120.2760",
    });
    const digests = acceptedDigests();
    nativeBoundary.observeFileDigest.mockImplementation(async (filePath) =>
      Promise.resolve(digests.get(filePath) ?? "0".repeat(64)),
    );
  });

  it("runs the qualified native artifact without activating MXC (#8178)", async () => {
    const operations = controlPlane();

    const result = await runMxcWindowsInactiveOnboarding(onboardingInput(operations));

    expect(result.computePlan).toEqual({ driverName: "mxc", gatewayLauncher: "openshell" });
    expect(result.bootstrapResult).toMatchObject({
      outcome: "ready",
      resourceState: "active",
      recoveryRequired: false,
    });
    expect(nativeBoundary.observeFileDigest).toHaveBeenCalledTimes(10);
    expect(operations.verifyAndCreate).toHaveBeenCalledTimes(1);
    expect(operations.verifyReadiness).toHaveBeenCalledTimes(1);
    expect(operations.recoverCreate).not.toHaveBeenCalled();
    expect(Object.hasOwn(CURRENT_RUNTIME_PROVIDER_BUNDLES, "mxc")).toBe(false);
  });

  it("rejects attachment drift before the create operation (#8178)", async () => {
    const operations = controlPlane();
    const digests = acceptedDigests();
    let observations = 0;
    nativeBoundary.observeFileDigest.mockImplementation(async (filePath) => {
      observations += 1;
      return observations > 5 ? "f".repeat(64) : (digests.get(filePath) ?? "0".repeat(64));
    });

    await expect(runMxcWindowsInactiveOnboarding(onboardingInput(operations))).rejects.toThrow(
      /observed distribution identity does not match the accepted identity/u,
    );
    expect(operations.verifyAndCreate).not.toHaveBeenCalled();
    expect(operations.verifyReadiness).not.toHaveBeenCalled();
    expect(operations.recoverCreate).not.toHaveBeenCalled();
  });

  it("rejects an unaccepted workload before the create operation (#8178)", async () => {
    const operations = controlPlane();
    const input = onboardingInput(operations);
    const workload = { ...input.bootstrap.workload, agent: "hermes" };

    await expect(
      runMxcWindowsInactiveOnboarding({
        ...input,
        bootstrap: { ...input.bootstrap, workload } as typeof input.bootstrap,
      }),
    ).rejects.toThrow(/does not match the attached provider workload contract/u);
    expect(nativeBoundary.observeFileDigest).toHaveBeenCalledTimes(5);
    expect(operations.verifyAndCreate).not.toHaveBeenCalled();
  });

  it("requalifies the installation before recovery (#8178)", async () => {
    const operations = controlPlane();

    const result = await recoverMxcWindowsInactiveOnboarding(onboardingInput(operations));

    expect(result.bootstrapResult).toMatchObject({
      outcome: "not-created",
      reason: "recovered",
      resourceState: "absent",
      recoveryRequired: false,
    });
    expect(nativeBoundary.observeFileDigest).toHaveBeenCalledTimes(10);
    expect(operations.recoverCreate).toHaveBeenCalledTimes(1);
    expect(operations.verifyAndCreate).not.toHaveBeenCalled();
    expect(operations.verifyReadiness).not.toHaveBeenCalled();
  });
});
