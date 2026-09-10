// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createMxcOpenShellDistributionAuthority,
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
  resolveMxcOpenShellDistributionAuthority,
  type MxcOpenShellAttachmentAuthority,
  type MxcOpenShellAttachmentObservation,
  type MxcOpenShellDistributionAuthority,
} from "./mxc-openshell-attachment";
import type { MxcOpenShellAttachmentObservationRequest } from "./mxc-openshell-observer";

export const MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS = {
  distribution:
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.distribution.sha256,
  cli: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.components.cliSha256,
  gateway:
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.components.gatewaySha256,
  wxcExec:
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.components.wxcExecSha256,
  config:
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.gateway.configSha256,
} as const;

export const MXC_OPENSHELL_ATTACHMENT_TEST_DISTRIBUTION_ARTIFACT_PATH =
  "C:\\OpenShell\\packages\\openshell-mxc-demo-v0.0.24.zip";

export function mxcOpenShellAttachmentFixture(
  version = MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.distribution
    .version,
): {
  readonly authority: MxcOpenShellAttachmentAuthority;
  readonly observation: MxcOpenShellAttachmentObservation;
} {
  const distributionAuthority = createMxcOpenShellDistributionAuthority(
    MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
  );
  const accepted = {
    ...structuredClone(MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation),
    distribution: {
      ...MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.distribution,
      version,
    },
  };
  return {
    authority: resolveMxcOpenShellDistributionAuthority(distributionAuthority),
    observation: {
      ...accepted,
      distributionRoot: "C:\\OpenShell",
      mxcRoot: "C:\\mxc-kit",
      cliPath: "C:\\OpenShell\\bin\\openshell.exe",
      gatewayPath: "C:\\OpenShell\\bin\\openshell-gateway.exe",
      wxcExecPath: "C:\\mxc-kit\\bin\\wxc-exec.exe",
      gatewayConfigPath: "C:\\ProgramData\\NVIDIA\\OpenShell\\gateway.toml",
    },
  };
}

export function mxcOpenShellDistributionTestFixture(
  version = MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.distribution
    .version,
): {
  readonly authority: MxcOpenShellDistributionAuthority;
  readonly observation: MxcOpenShellAttachmentObservation;
} {
  const source = mxcOpenShellAttachmentFixture(version).observation;
  return {
    authority: createMxcOpenShellDistributionAuthority(
      MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    ),
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
