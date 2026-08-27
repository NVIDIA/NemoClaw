// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MxcOpenShellAttachmentError,
  qualifyMxcOpenShellAttachment,
  type MxcOpenShellAttachmentInput,
} from "./mxc-openshell-attachment";

const DIGESTS = {
  distribution: "1".repeat(64),
  cli: "2".repeat(64),
  gateway: "3".repeat(64),
  wxcExec: "4".repeat(64),
  config: "5".repeat(64),
} as const;

function attachment(): MxcOpenShellAttachmentInput {
  const identity = {
    distribution: {
      version: "0.0.21",
      revision: "a".repeat(40),
      sha256: DIGESTS.distribution,
    },
    components: {
      cliSha256: DIGESTS.cli,
      gatewaySha256: DIGESTS.gateway,
      wxcExecSha256: DIGESTS.wxcExec,
    },
    gateway: {
      configSha256: DIGESTS.config,
      driver: "mxc" as const,
      backend: "process_container" as const,
    },
  };
  return {
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: "mxc",
    mode: "attach-existing",
    expected: identity,
    observed: {
      ...structuredClone(identity),
      distributionRoot: "C:\\OpenShell",
      cliPath: "C:\\OpenShell\\bin\\openshell.exe",
      gatewayPath: "C:\\OpenShell\\bin\\openshell-gateway.exe",
      wxcExecPath: "C:\\OpenShell\\mxc\\wxc-exec.exe",
      gatewayConfigPath: "C:\\ProgramData\\NVIDIA\\OpenShell\\gateway.toml",
    },
  };
}

describe("inactive OpenShell MXC installation attachment", () => {
  it("binds one accepted distribution and gateway configuration without installing it (#8178)", () => {
    const receipt = qualifyMxcOpenShellAttachment(attachment());

    expect(receipt).toEqual({
      contractVersion: 1,
      providerId: "mxc",
      mode: "attach-existing",
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      distribution: {
        version: "0.0.21",
        revision: "a".repeat(40),
        sha256: DIGESTS.distribution,
        root: "C:\\OpenShell",
      },
      components: {
        cli: {
          path: "C:\\OpenShell\\bin\\openshell.exe",
          sha256: DIGESTS.cli,
        },
        gateway: {
          path: "C:\\OpenShell\\bin\\openshell-gateway.exe",
          sha256: DIGESTS.gateway,
        },
        wxcExec: {
          path: "C:\\OpenShell\\mxc\\wxc-exec.exe",
          sha256: DIGESTS.wxcExec,
        },
      },
      gateway: {
        configSha256: DIGESTS.config,
        driver: "mxc",
        backend: "process_container",
        configPath: "C:\\ProgramData\\NVIDIA\\OpenShell\\gateway.toml",
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.components.gateway)).toBe(true);
  });

  it.each([
    [
      "distribution package",
      (input: MxcOpenShellAttachmentInput) => {
        const observed = input.observed as unknown as { distribution: { sha256: string } };
        observed.distribution.sha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell CLI",
      (input: MxcOpenShellAttachmentInput) => {
        const observed = input.observed as unknown as { components: { cliSha256: string } };
        observed.components.cliSha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell gateway",
      (input: MxcOpenShellAttachmentInput) => {
        const observed = input.observed as unknown as { components: { gatewaySha256: string } };
        observed.components.gatewaySha256 = "6".repeat(64);
      },
    ],
    [
      "wxc-exec",
      (input: MxcOpenShellAttachmentInput) => {
        const observed = input.observed as unknown as { components: { wxcExecSha256: string } };
        observed.components.wxcExecSha256 = "6".repeat(64);
      },
    ],
    [
      "gateway configuration",
      (input: MxcOpenShellAttachmentInput) => {
        const observed = input.observed as unknown as { gateway: { configSha256: string } };
        observed.gateway.configSha256 = "6".repeat(64);
      },
    ],
  ])("rejects %s identity drift before attachment (#8178)", (_label, mutate) => {
    const input = structuredClone(attachment());
    mutate(input);

    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(
      /observed distribution identity does not match/u,
    );
  });

  it("rejects components from another distribution root (#8178)", () => {
    const input = structuredClone(attachment());
    const observed = input.observed as unknown as { gatewayPath: string };
    observed.gatewayPath = "C:\\OtherOpenShell\\openshell-gateway.exe";

    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(
      /gateway path must remain inside the observed distribution root/u,
    );
  });

  it("rejects an unsupported backend before attachment (#8178)", () => {
    const input = structuredClone(attachment()) as unknown as Record<string, unknown>;
    const expected = input.expected as Record<string, unknown>;
    const gateway = expected.gateway as Record<string, unknown>;
    gateway.backend = "isolation_session";

    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(
      /backend must be 'process_container'/u,
    );
  });

  it("rejects credential-bearing fields instead of copying them into the receipt (#8178)", () => {
    const input = structuredClone(attachment()) as unknown as Record<string, unknown>;
    input.providerToken = "must-not-enter-attachment-receipt";

    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(MxcOpenShellAttachmentError);
    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(/unknown or missing fields/u);
  });

  it.each([
    ["provider identity", { providerId: "docker" }],
    ["contract version", { contractVersion: 2 }],
    ["installation mutation", { mode: "install" }],
  ])("rejects $0 drift before attachment (#8178)", (_label, change) => {
    const input = { ...attachment(), ...change };

    expect(() => qualifyMxcOpenShellAttachment(input)).toThrow(MxcOpenShellAttachmentError);
  });
});
