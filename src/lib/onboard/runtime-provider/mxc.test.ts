// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import { createDockerRuntimeProviderBundle } from "./docker";
import { createMxcRuntimeProviderBundle } from "./mxc";
import {
  createRuntimeProviderBundleRegistry,
  RuntimeProviderRegistrationError,
  requireRuntimeProviderMutationAuthority,
} from "./registry";

const NATIVE_RECEIPT = nativeArtifactWorkloadReceiptFixture(
  encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
);

function candidateBundle() {
  return createMxcRuntimeProviderBundle({
    hostFacts: {
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28000.1836",
    },
  });
}

describe("inactive OpenShell MXC runtime provider", () => {
  it.each([
    "plan",
    "capabilities",
    "preflightDoctor",
    "gateway",
    "workload",
    "lifecycle",
    "mutationAuthority",
    "stateMutation",
    "bootstrap",
    "snapshot",
    "recovery",
    "cleanup",
    "containerEngine",
  ] as const)(
    "registers one identity-consistent candidate without entering production selection [%s] (#8178)",
    (surface) => {
      const providers = createRuntimeProviderBundleRegistry([["mxc", candidateBundle()]]);
      const provider = providers.mxc!;

      expect(Object.hasOwn(CURRENT_RUNTIME_PROVIDER_BUNDLES, "mxc")).toBe(false);
      expect(provider.identity).toMatchObject({ id: "mxc", displayName: "OpenShell MXC" });

      expect(provider[surface].providerId, surface).toBe("mxc");
    },
  );

  it("accepts only a validated OpenClaw Windows native-artifact receipt (#8178)", () => {
    const provider = candidateBundle();
    const cloned = cloneSandboxWorkloadReceipt(NATIVE_RECEIPT);
    const malformed = {
      ...NATIVE_RECEIPT,
      artifact: { ...NATIVE_RECEIPT.artifact, digest: `sha256:${"A".repeat(64)}` },
    } as unknown as SandboxWorkloadReceipt;
    const legacy = {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: null,
      shared: false,
    } as const satisfies SandboxWorkloadReceipt;

    expect(cloned).toEqual(NATIVE_RECEIPT);
    expect(cloned).not.toBe(NATIVE_RECEIPT);
    expect(provider.workload.acceptsReceipt(cloned)).toBe(true);
    expect(provider.workload.acceptsReceipt(undefined)).toBe(false);
    expect(provider.workload.acceptsReceipt(legacy)).toBe(false);
    expect(provider.workload.acceptsReceipt(malformed)).toBe(false);
    expect(createDockerRuntimeProviderBundle().workload.acceptsReceipt(cloned)).toBe(false);
  });

  it("reports candidate host facts without claiming runtime readiness (#8178)", () => {
    expect(candidateBundle().preflightDoctor.inspectHost()).toEqual({
      group: "Host",
      label: "OpenShell MXC process_container candidate",
      status: "info",
      detail: "Windows x64 build 28000 meets the inactive host floor.",
      hint: "MXC remains unavailable until the OpenShell package and live E2E gates pass.",
    });

    const rejected = createMxcRuntimeProviderBundle({
      hostFacts: {
        platform: "linux",
        nativeArchitecture: "x64",
        release: "6.6.87.2-microsoft-standard-WSL2",
      },
    });
    expect(rejected.preflightDoctor.inspectHost()).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/WSL is not a native Windows host/u),
    });
  });

  it("fails closed for every unqualified mutation and lifecycle surface (#8178)", () => {
    const provider = candidateBundle();

    expect(provider.capabilities).toMatchObject({
      hostLocalInference: false,
      directLifecycle: false,
      workloadImageCleanup: false,
      readOnlyHostMounts: {
        supported: false,
        reason: expect.stringMatching(/host-directory sharing contract/u),
      },
    });
    for (const surface of [
      provider.lifecycle,
      provider.mutationAuthority,
      provider.stateMutation,
      provider.bootstrap,
      provider.snapshot,
      provider.recovery,
      provider.cleanup,
      provider.containerEngine,
    ]) {
      expect(surface).toMatchObject({ providerId: "mxc", supported: false });
      expect("reason" in surface ? surface.reason : "").not.toBe("");
    }
    expect(provider.preflightDoctor.preflightLifecycle("start", {} as never)).toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/has not passed live E2E/u),
    });
    expect(() => requireRuntimeProviderMutationAuthority(provider, "registration")).toThrow(
      /does not authorize 'registration'/u,
    );
  });

  it("rejects a native-artifact profile with an unaccepted agent (#8178)", () => {
    const provider = candidateBundle();
    const invalid = {
      ...provider,
      workload: {
        ...provider.workload,
        profile: {
          ...provider.workload.profile,
          nativeArtifactSupport: {
            ...provider.workload.profile.nativeArtifactSupport!,
            agents: ["hermes"],
          },
        },
      },
    };

    expect(() =>
      createRuntimeProviderBundleRegistry([["mxc", invalid as typeof provider]]),
    ).toThrow(RuntimeProviderRegistrationError);
  });
});
