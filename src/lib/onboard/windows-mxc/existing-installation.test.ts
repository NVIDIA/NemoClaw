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
import { MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID } from "../runtime-provider/mxc-openshell-attachment";
import {
  mxcOpenShellAttachmentDigestMap,
  mxcOpenShellAttachmentObservationRequest,
  mxcOpenShellDistributionTestFixture,
} from "../runtime-provider/mxc-openshell-attachment-test-fixture";
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

describe("inactive native Windows OpenShell MXC existing-installation composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeBoundary.observeHostFacts.mockReset();
    nativeBoundary.observeFileDigest.mockReset();
  });

  it("retains the qualified receipt without entering runtime selection (#8178)", async () => {
    const attachment = mxcOpenShellDistributionTestFixture();
    const digests = mxcOpenShellAttachmentDigestMap(attachment.observation);
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
      openshellDistributionAuthority: attachment.authority,
      attachmentObservation: mxcOpenShellAttachmentObservationRequest(attachment.observation),
      bootstrapControlPlane,
    });

    expect(result.attachmentReceipt).toMatchObject({
      contractVersion: 3,
      providerId: "mxc",
      acceptance: "qualification",
      distributionProfileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
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
    const attachment = mxcOpenShellDistributionTestFixture();
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "linux",
      nativeArchitecture: "x64",
      release: "6.6.87.2-microsoft-standard-WSL2",
    });

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellDistributionAuthority: attachment.authority,
        attachmentObservation: mxcOpenShellAttachmentObservationRequest(attachment.observation),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/WSL is not a native Windows host/u);
    expect(nativeBoundary.observeFileDigest).not.toHaveBeenCalled();
  });

  it("rejects an unqualified architecture before observing installation files (#8178)", async () => {
    const attachment = mxcOpenShellDistributionTestFixture();
    nativeBoundary.observeHostFacts.mockReturnValue({
      platform: "win32",
      nativeArchitecture: "arm64",
      release: "10.0.28000.2525",
    });

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellDistributionAuthority: attachment.authority,
        attachmentObservation: mxcOpenShellAttachmentObservationRequest(attachment.observation),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/currently qualifies x64 only/u);
    expect(nativeBoundary.observeFileDigest).not.toHaveBeenCalled();
  });

  it("rejects a caller-constructed distribution authority before host observation (#10583)", async () => {
    const authority = mxcOpenShellDistributionTestFixture().authority;

    await expect(
      attachMxcWindowsExistingInstallation({
        openshellDistributionAuthority: { ...authority },
        attachmentObservation: mxcOpenShellAttachmentObservationRequest(),
        bootstrapControlPlane: controlPlane(),
      }),
    ).rejects.toThrow(/distribution authority is not provider-owned/u);
    expect(nativeBoundary.observeHostFacts).not.toHaveBeenCalled();
    expect(nativeBoundary.observeFileDigest).not.toHaveBeenCalled();
  });
});
