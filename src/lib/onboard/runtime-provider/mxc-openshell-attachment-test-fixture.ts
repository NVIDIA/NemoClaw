// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createMxcOpenShellAttachmentTestAuthority,
  type MxcOpenShellAttachmentAuthority,
  type MxcOpenShellAttachmentObservation,
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
