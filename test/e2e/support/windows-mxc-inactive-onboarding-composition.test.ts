// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { createMxcNativeArtifactBootstrapSurface } from "../../../src/lib/onboard/runtime-provider/mxc-bootstrap.ts";
import {
  mxcOpenShellAttachmentDigestMap,
  mxcOpenShellAttachmentObservationRequest,
  mxcOpenShellDistributionTestFixture,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-attachment-test-fixture.ts";
import type { MxcWindowsOpenShellExecutorRuntime } from "../../../src/lib/onboard/runtime-provider/mxc-windows-openshell-executor.ts";
import { nativeArtifactWorkloadReceiptFixture } from "../../../src/lib/onboard/workload/native-artifact-test-fixture.ts";
import {
  createWindowsMxcInactiveOnboardingComposition,
  type WindowsMxcInactiveOnboardingCompositionInput,
} from "../live/windows-mxc-inactive-onboarding-composition.ts";

const REQUIRED_ENVIRONMENT = [
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

function missingTestDigest(): never {
  throw new Error("unknown test path");
}

function bootstrap() {
  const workload = nativeArtifactWorkloadReceiptFixture(
    encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
  );
  return {
    sandboxName: "alpha",
    lifecycleGeneration: "generation-7",
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-2026-7-1",
    workload: {
      ...workload,
      launch: { ...workload.launch, environmentNames: REQUIRED_ENVIRONMENT },
    },
  } as const;
}

function executorRuntime(): MxcWindowsOpenShellExecutorRuntime {
  const digests = mxcOpenShellAttachmentDigestMap();
  return {
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      OPENAI_API_KEY: "must-not-reach-openshell",
    },
    observeFileDigest: vi.fn(async (filePath) => {
      return digests.get(filePath) ?? missingTestDigest();
    }),
    observeArtifactTree: vi.fn(() => ({
      directories: ["C:\\openclaw-2026-7-1"],
      files: [
        {
          path: "C:\\openclaw-2026-7-1\\node\\node.exe",
          sha256: "c".repeat(64),
        },
      ],
      sha256: "a".repeat(64),
    })),
    acquirePins: vi.fn(async () => ({
      isActive: () => true,
      waitForLoss: () => new Promise<void>(() => undefined),
      release: async () => undefined,
    })),
    runCommand: vi.fn(async () => ({ status: null, stdout: "", stderr: "" })),
  };
}

function compositionInput(
  runtime: MxcWindowsOpenShellExecutorRuntime,
): WindowsMxcInactiveOnboardingCompositionInput {
  const distribution = mxcOpenShellDistributionTestFixture();
  return {
    distributionAuthority: distribution.authority,
    attachmentObservation: mxcOpenShellAttachmentObservationRequest(distribution.observation),
    gatewayName: "local",
    workspace: "default",
    policy: { path: "C:\\policy\\openclaw.yaml", sha256: "b".repeat(64) },
    bootstrap: bootstrap(),
    executorRuntime: runtime,
  };
}

async function issuedPlan() {
  let issued:
    | Parameters<
        Awaited<
          ReturnType<typeof createWindowsMxcInactiveOnboardingComposition>
        >["installation"]["bootstrapControlPlane"]["verifyAndCreate"]
      >[0]
    | undefined;
  const surface = createMxcNativeArtifactBootstrapSurface({
    verifyAndCreate: async (plan) => {
      issued = plan;
      return { status: "not-created", reason: "create-rejected" };
    },
    verifyReadiness: async () => {
      throw new Error("unreachable");
    },
    recoverCreate: async () => ({ status: "absent" }),
  });
  await surface.run({ providerId: "mxc", ...bootstrap() });
  return issued!;
}

describe("inactive Windows MXC qualification composition", () => {
  it("binds the accepted attachment, trusted executor, and request-scoped create (#10585)", async () => {
    const runtime = executorRuntime();
    const input = compositionInput(runtime);
    const composed = await createWindowsMxcInactiveOnboardingComposition(input);

    await expect(
      composed.installation.bootstrapControlPlane.verifyAndCreate(await issuedPlan()),
    ).resolves.toEqual({ status: "unknown" });

    expect(composed.installation.openshellDistributionAuthority).toBe(input.distributionAuthority);
    expect(composed.installation.attachmentObservation).toBe(input.attachmentObservation);
    expect(runtime.runCommand).toHaveBeenCalledOnce();
    const [command, environment] = vi.mocked(runtime.runCommand).mock.calls[0]!;
    expect(command.executablePath).toMatch(/openshell[.]exe$/u);
    expect(command.arguments).toEqual(
      expect.arrayContaining(["sandbox", "create", "--driver-config-json"]),
    );
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("rejects attachment drift before composing a mutable control plane (#10585)", async () => {
    const runtime = executorRuntime();
    vi.mocked(runtime.observeFileDigest).mockResolvedValue("f".repeat(64));

    await expect(
      createWindowsMxcInactiveOnboardingComposition(compositionInput(runtime)),
    ).rejects.toThrow(/does not match the accepted identity/u);
    expect(runtime.acquirePins).not.toHaveBeenCalled();
    expect(runtime.runCommand).not.toHaveBeenCalled();
  });
});
