// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createMxcOpenShellAttachmentTestAuthority,
  createMxcOpenShellDistributionAuthority,
  MXC_OPENSHELL_V0_0_24_QUALIFICATION_PROFILE_ID,
  type MxcOpenShellAttachmentAuthority,
  type MxcOpenShellAttachmentObservation,
  type MxcOpenShellDistributionAuthority,
} from "./mxc-openshell-attachment";

export const MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS = {
  distribution: "1".repeat(64),
  cli: "2".repeat(64),
  gateway: "3".repeat(64),
  wxcExec: "4".repeat(64),
  config: "5".repeat(64),
} as const;

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

export function mxcOpenShellV0_0_24QualificationFixture(): {
  readonly authority: MxcOpenShellDistributionAuthority;
  readonly observation: MxcOpenShellAttachmentObservation;
} {
  const source = mxcOpenShellAttachmentFixture("0.0.24").observation;
  return {
    authority: createMxcOpenShellDistributionAuthority(
      MXC_OPENSHELL_V0_0_24_QUALIFICATION_PROFILE_ID,
    ),
    observation: {
      ...source,
      distribution: {
        version: "0.0.24",
        revision: "e1b48323e4efcb560900508bdcd76d2b5d216678",
        sha256: "296ba2677f8f692b1c3f14b4fae6bb2a75d52f94c071ec2ebdf676405a80613d",
      },
      components: {
        cliSha256: "23d00a88daa5f2aa6151d9112a6845e843ca1e08cbaf55f8eaa337b72dd9155a",
        gatewaySha256: "62b3e231f5d40c5d178d08172ddb65536f124bdb8c7c04d90fb9dca50a5ac137",
        wxcExecSha256: "6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a",
      },
      gateway: {
        ...source.gateway,
        configSha256: "1c86a32a52d068677b5140975c6b870d5ed46dc553500ebb790b58e207ac7290",
      },
    },
  };
}
