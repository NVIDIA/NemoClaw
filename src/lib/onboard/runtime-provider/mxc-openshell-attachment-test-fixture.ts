// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createMxcOpenShellAttachmentTestAuthority,
  createMxcOpenShellDistributionTestAuthority,
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  type MxcOpenShellAttachmentAuthority,
  type MxcOpenShellAttachmentObservation,
  type MxcOpenShellDistributionAuthority,
} from "./mxc-openshell-attachment";
import type { MxcOpenShellAttachmentObservationRequest } from "./mxc-openshell-observer";

export const MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS = {
  distribution: "1".repeat(64),
  cli: "2".repeat(64),
  gateway: "3".repeat(64),
  wxcExec: "4".repeat(64),
  config: "5".repeat(64),
} as const;

export const MXC_OPENSHELL_ATTACHMENT_TEST_DISTRIBUTION_ARTIFACT_PATH =
  "C:\\OpenShell\\packages\\openshell-test.zip";

export function mxcOpenShellAttachmentFixture(version = "0.0.21"): {
  readonly authority: MxcOpenShellAttachmentAuthority;
  readonly observation: MxcOpenShellAttachmentObservation;
} {
  const accepted = {
    distribution: {
      version,
      revision: "a".repeat(40),
      sha256: MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS.distribution,
    },
    components: {
      cliSha256: MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS.cli,
      gatewaySha256: MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS.gateway,
      wxcExecSha256: MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS.wxcExec,
    },
    gateway: {
      configSha256: MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS.config,
      driver: "mxc" as const,
      backend: "process_container" as const,
    },
  };
  return {
    authority: createMxcOpenShellAttachmentTestAuthority(version),
    observation: {
      ...structuredClone(accepted),
      distributionRoot: "C:\\OpenShell",
      mxcRoot: "C:\\mxc-kit",
      cliPath: "C:\\OpenShell\\bin\\openshell.exe",
      gatewayPath: "C:\\OpenShell\\bin\\openshell-gateway.exe",
      wxcExecPath: "C:\\mxc-kit\\bin\\wxc-exec.exe",
      gatewayConfigPath: "C:\\ProgramData\\NVIDIA\\OpenShell\\gateway.toml",
    },
  };
}

export function mxcOpenShellDistributionTestFixture(version = "0.0.21"): {
  readonly authority: MxcOpenShellDistributionAuthority;
  readonly observation: MxcOpenShellAttachmentObservation;
} {
  const source = mxcOpenShellAttachmentFixture(version).observation;
  return {
    authority: createMxcOpenShellDistributionTestAuthority(version),
    observation: source,
  };
}

export function mxcOpenShellAttachmentObservationRequest(
  observed = mxcOpenShellDistributionTestFixture().observation,
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
      distributionArtifactPath: MXC_OPENSHELL_ATTACHMENT_TEST_DISTRIBUTION_ARTIFACT_PATH,
      distributionRoot: observed.distributionRoot,
      mxcRoot: observed.mxcRoot,
      cliPath: observed.cliPath,
      gatewayPath: observed.gatewayPath,
      wxcExecPath: observed.wxcExecPath,
      gatewayConfigPath: observed.gatewayConfigPath,
    },
  };
}

export function mxcOpenShellAttachmentDigestMap(
  observed = mxcOpenShellDistributionTestFixture().observation,
): Map<string, string> {
  return new Map([
    [MXC_OPENSHELL_ATTACHMENT_TEST_DISTRIBUTION_ARTIFACT_PATH, observed.distribution.sha256],
    [observed.cliPath, observed.components.cliSha256],
    [observed.gatewayPath, observed.components.gatewaySha256],
    [observed.wxcExecPath, observed.components.wxcExecSha256],
    [observed.gatewayConfigPath, observed.gateway.configSha256],
  ]);
}
