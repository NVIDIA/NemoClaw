// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { attachMxcWindowsExistingInstallation } from "./existing-installation";

function controlPlane(): MxcNativeArtifactControlPlane {
  return {
    contractVersion: 1,
    providerId: "mxc",
    verifyAndCreate: vi.fn(async () => ({ status: "unknown" as const })),
    verifyReadiness: vi.fn(async () => {
      throw new Error("inactive test control plane has no readiness evidence");
    }),
    recoverCreate: vi.fn(async () => ({ status: "absent" as const })),
  };
}

function observationRequest(
  observed = mxcOpenShellAttachmentFixture("0.0.24").observation,
): MxcOpenShellAttachmentObservationRequest {
  return {
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: "mxc",
    mode: "attach-existing",
    observedDistribution: {
      version: observed.distribution.version,
      revision: observed.distribution.revision,
    },
    observedGateway: {
      driver: "mxc",
      backend: "process_container",
    },
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

function acceptedDigests(observed = mxcOpenShellAttachmentFixture("0.0.24").observation) {
  return new Map<string, string>([
    ["C:\\OpenShell\\packages\\openshell-0.0.24.zip", observed.distribution.sha256],
    [observed.cliPath, observed.components.cliSha256],
    [observed.gatewayPath, observed.components.gatewaySha256],
    [observed.wxcExecPath, observed.components.wxcExecSha256],
    [observed.gatewayConfigPath, observed.gateway.configSha256],
  ]);
}

describe("inactive native Windows OpenShell MXC existing-installation composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeBoundary.observeHostFacts.mockReset();
    nativeBoundary.observeFileDigest.mockReset();
  });

  it("retains the qualified receipt without entering runtime selection (#8178)", async () => {
    const attachment = mxcOpenShellAttachmentFixture("0.0.24");
    const digests = acceptedDigests(attachment.observation);
    const bootstrapControlPlane = controlPlane();
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120.2760",
    });
    nativeBoundary.observeFileDigest.mockImplementation(async (filePath: string) =>
      digests.get(filePath)!,
    );

    const result = await attachMxcWindowsExistingInstallation({
      openshellAttachmentAuthority: attachment.authority,
      attachmentObservation: observationRequest(attachment.observation),
      bootstrapControlPlane,
    });

    expect(result.attachmentReceipt).toMatchObject({
      contractVersion: 2,
      providerId: "mxc",
      distribution: { root: "C:\\OpenShell" },
      components: {
        wxcExec: {
          root: "C:\\mxc-kit",
          path: "C:\\mxc-kit\\bin\\wxc-exec.exe",
        },
      },
    });
    expect(result.hostFacts).toEqual({
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120.2760",
    });
    expect(result.provider.identity.id).toBe("mxc");
    expect(nativeBoundary.observeFileDigest).toHaveBeenCalledTimes(5);
    expect(bootstrapControlPlane.verifyAndCreate).not.toHaveBeenCalled();
    expect(bootstrapControlPlane.verifyReadiness).not.toHaveBeenCalled();
    expect(bootstrapControlPlane.recoverCreate).not.toHaveBeenCalled();
    expect(Object.hasOwn(CURRENT_RUNTIME_PROVIDER_BUNDLES, "mxc")).toBe(false);
  });

  it("rejects WSL before observing installation files (#8178)", async () => {
    const attachment = mxcOpenShellAttachmentFixture("0.0.24");
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "linux",
      nativeArchitecture: "x64",
      release: "6.6.87.2-microsoft-standard-WSL2",
    });

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellAttachmentAuthority: attachment.authority,
        attachmentObservation: observationRequest(attachment.observation),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/WSL is not a native Windows host/u);
    expect(nativeBoundary.observeFileDigest).not.toHaveBeenCalled();
  });

  it("rejects an unqualified architecture before observing installation files (#8178)", async () => {
    const attachment = mxcOpenShellAttachmentFixture("0.0.24");
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "win32",
      nativeArchitecture: "arm64",
      release: "10.0.28000.2525",
    });

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellAttachmentAuthority: attachment.authority,
        attachmentObservation: observationRequest(attachment.observation),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/currently qualifies x64 only/u);
    expect(nativeBoundary.observeFileDigest).not.toHaveBeenCalled();
  });

  it("rejects a caller-constructed attachment authority before provider composition (#8178)", async () => {
    const attachment = mxcOpenShellAttachmentFixture("0.0.24");
    const digests = acceptedDigests(attachment.observation);
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120.2760",
    });
    nativeBoundary.observeFileDigest.mockImplementation(async (filePath: string) =>
      digests.get(filePath)!,
    );

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellAttachmentAuthority: { ...attachment.authority },
        attachmentObservation: observationRequest(attachment.observation),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/accepted identity authority is not provider-owned/u);
  });
});
