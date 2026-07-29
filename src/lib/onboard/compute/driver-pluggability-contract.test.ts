// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  collectDoctorHostRuntimeCheck,
  type DoctorHostRuntimeAdapterRegistry,
} from "../../actions/sandbox/doctor-host-command";
import {
  resolveSandboxLifecycleRuntimeAdapter,
  type SandboxLifecycleRuntimeAdapter,
  type SandboxLifecycleRuntimeAdapterRegistry,
} from "../../actions/sandbox/runtime/lifecycle-runtime";
import type { ManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORM,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
} from "../managed-image/contract";
import { resolveSandboxWorkloadRuntimeCapabilities } from "../workload/runtime";
import { resolveSandboxWorkloadSource, SandboxWorkloadSourceError } from "../workload/source";
import {
  type ManagedGatewayDriverProfile,
  type ManagedGatewayDriverProfileRegistry,
  type ManagedGatewayRuntimeAdapterRegistry,
  resolveManagedGatewayDriverProfile,
  resolveManagedGatewayRuntimeAdapter,
} from "./managed-gateway-profile";
import {
  type OpenShellComputeCapabilitiesRegistry,
  type OpenShellComputePlanRegistry,
  resolveOpenShellComputeCapabilities,
  resolveOpenShellComputeSelection,
} from "./plan";
import {
  type ManagedGatewayRecoveryAdapterRegistry,
  resolveManagedGatewayRecoveryRuntime,
} from "./recovery-runtime";

const MXC_DRIVER = "mxc";
const MXC_ENDPOINT = "unix:///run/user/1000/mxc/control.sock";

const MANAGED_IMAGE_SUPPORT = {
  exactDigestReferences: true,
  platforms: [MANAGED_IMAGE_PLATFORM],
  startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
  capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
} as const;

function hermesContract(): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES.hermes;
  const digest = `sha256:${"a".repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent: "hermes",
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: "b".repeat(40),
      release: "v0.0.98",
      cohort: "ghrun-7744-3",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

describe("OpenShell compute-driver pluggability contract", () => {
  it("routes an injected MXC driver through every runtime seam without inherited Docker or Podman behavior (#7744)", () => {
    const plans: OpenShellComputePlanRegistry = {
      mxc: { driverName: MXC_DRIVER, gatewayLauncher: "nemoclaw" },
    };
    const capabilities: OpenShellComputeCapabilitiesRegistry = {
      mxc: { hostLocalInference: false },
    };
    const plan = resolveOpenShellComputeSelection(
      {
        requestedDriver: MXC_DRIVER,
        autoPlan: { driverName: "unused-auto", gatewayLauncher: "openshell" },
      },
      plans,
    );
    expect(plan).toEqual({ driverName: MXC_DRIVER, gatewayLauncher: "nemoclaw" });
    expect(resolveOpenShellComputeCapabilities(plan, capabilities)).toEqual({
      hostLocalInference: false,
    });

    const mxcProfile = {
      allowWildcardBind: false,
      driverName: MXC_DRIVER,
      displayName: "MXC",
      incompatibleRuntimeEnvironmentKeys: [],
      launchPolicy: "host-only",
      runtimeMarkerPolicy: "process-env",
      runtimeEnvironmentKeys: ["OPENSHELL_MXC_ENDPOINT"],
      sandboxReachability: "driver-native",
      capabilities: {
        containerizedGatewayCompat: false,
        legacyDockerGatewayCleanup: false,
        legacyDockerVolumeCleanup: false,
        localSupervisorBinary: false,
        packageManagedService: false,
      },
    } as const satisfies ManagedGatewayDriverProfile;
    const profiles: ManagedGatewayDriverProfileRegistry = { mxc: mxcProfile };
    const resolvedProfile = resolveManagedGatewayDriverProfile(plan, profiles);
    expect(resolvedProfile).toBe(mxcProfile);

    const lifecycleAdapter = {
      driverName: MXC_DRIVER,
      launchPolicy: "host-only",
      runtimeMarkerPolicy: "process-env",
      sandboxReachability: "driver-native",
      marker: "mxc-only",
    } as const;
    const lifecycleAdapters: ManagedGatewayRuntimeAdapterRegistry<typeof lifecycleAdapter> = {
      mxc: lifecycleAdapter,
    };
    expect(
      resolveManagedGatewayRuntimeAdapter(
        resolvedProfile as ManagedGatewayDriverProfile,
        lifecycleAdapters,
      ),
    ).toBe(lifecycleAdapter);

    const sandboxLifecycleAdapter = {
      channelStopTransport: "openshell",
      displayName: "MXC",
      driverName: MXC_DRIVER,
      preflight: vi.fn(() => null),
      start: vi.fn(() => ({ exitCode: 0 })),
      stop: vi.fn((_input, _deps, hooks) => {
        hooks.beforeStop();
        return { exitCode: 0, state: "stopped" as const };
      }),
    } satisfies SandboxLifecycleRuntimeAdapter;
    const sandboxLifecycleAdapters: SandboxLifecycleRuntimeAdapterRegistry = {
      mxc: sandboxLifecycleAdapter,
    };
    expect(resolveSandboxLifecycleRuntimeAdapter(MXC_DRIVER, sandboxLifecycleAdapters)).toBe(
      sandboxLifecycleAdapter,
    );

    const resolveRecoveryEnvironment = vi.fn(() => ({
      OPENSHELL_MXC_ENDPOINT: MXC_ENDPOINT,
    }));
    const recoveryAdapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: MXC_DRIVER,
        resolveEnvironment: resolveRecoveryEnvironment,
      },
    };
    const runtimeBinding: ManagedGatewayRuntimeBinding = {
      version: 1,
      driverName: MXC_DRIVER,
      configSha256: "c".repeat(64),
      values: { endpoint: MXC_ENDPOINT },
    };
    expect(
      resolveManagedGatewayRecoveryRuntime(
        {
          driverName: MXC_DRIVER,
          environment: {},
          stateDir: "/state/mxc",
        },
        recoveryAdapters,
        () => runtimeBinding,
      ),
    ).toEqual({
      driverName: MXC_DRIVER,
      environment: { OPENSHELL_MXC_ENDPOINT: MXC_ENDPOINT },
    });
    expect(resolveRecoveryEnvironment).toHaveBeenCalledExactlyOnceWith(runtimeBinding);

    const inspectDoctorRuntime = vi.fn(() => ({
      group: "Host" as const,
      label: "MXC runtime",
      status: "ok" as const,
      detail: `connected via ${MXC_ENDPOINT}`,
    }));
    const doctorAdapters: DoctorHostRuntimeAdapterRegistry = {
      mxc: {
        driverName: MXC_DRIVER,
        inspect: inspectDoctorRuntime,
      },
    };
    expect(
      collectDoctorHostRuntimeCheck(
        {
          driverName: MXC_DRIVER,
          managedGatewayStateDirectory: "/state/mxc",
        },
        doctorAdapters,
      ),
    ).toEqual({
      group: "Host",
      label: "MXC runtime",
      status: "ok",
      detail: `connected via ${MXC_ENDPOINT}`,
    });
    expect(inspectDoctorRuntime).toHaveBeenCalledExactlyOnceWith(
      {
        driverName: MXC_DRIVER,
        managedGatewayStateDirectory: "/state/mxc",
      },
      {
        captureHostCommand: expect.any(Function),
      },
    );

    const workloadRuntime = resolveSandboxWorkloadRuntimeCapabilities(
      plan,
      {
        mxc: {
          support: MANAGED_IMAGE_SUPPORT,
          hostArchitectures: ["amd64"],
          managedImageSelectionPolicy: "require-managed",
          legacyDockerfileBuilds: false,
        },
      },
      "x64",
    );
    expect(workloadRuntime).toEqual({
      driverName: MXC_DRIVER,
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: MANAGED_IMAGE_SUPPORT,
    });

    const contract = hermesContract();
    expect(
      resolveSandboxWorkloadSource({
        agentName: "hermes",
        legacyDockerfilePath: "agents/hermes/Dockerfile",
        runtime: workloadRuntime,
        catalog: { hermes: contract },
      }),
    ).toEqual({
      kind: "managed-image",
      reference: contract.reference,
      contract,
    });
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "hermes",
        legacyDockerfilePath: "agents/hermes/Dockerfile",
        customDockerfilePath: "agents/hermes/CustomDockerfile",
        runtime: workloadRuntime,
        catalog: { hermes: contract },
      }),
    ).toThrow(SandboxWorkloadSourceError);
  });
});
