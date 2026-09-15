// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
  MxcOpenShellAttachmentError,
  createMxcOpenShellDistributionAuthority,
  qualifyMxcOpenShellAttachment,
  resolveMxcOpenShellDistributionAuthority,
  type MxcOpenShellAttachmentObservation,
  type MxcOpenShellDistributionProfileId,
} from "./mxc-openshell-attachment";
import {
  MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS as DIGESTS,
  mxcOpenShellAttachmentFixture,
  mxcOpenShellDistributionTestFixture,
} from "./mxc-openshell-attachment-test-fixture";

describe("inactive OpenShell MXC installation attachment", () => {
  it("binds one qualified development checkpoint without installing it (#10583)", () => {
    const { authority, observation } = mxcOpenShellAttachmentFixture();
    const receipt = qualifyMxcOpenShellAttachment(authority, observation);

    expect(authority).toEqual({
      contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
      providerId: "mxc",
      mode: "attach-existing",
      acceptance: "qualification",
      distributionProfileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
      acceptedIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(receipt).toEqual({
      contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
      providerId: "mxc",
      mode: "attach-existing",
      acceptance: "qualification",
      distributionProfileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      distribution: {
        version: "0.0.24",
        revision:
          MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE.expectation.distribution
            .revision,
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
          root: "C:\\mxc-kit",
          path: "C:\\mxc-kit\\bin\\wxc-exec.exe",
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

  it("creates qualification authority only from the provider-owned checkpoint (#10583)", () => {
    const authority = createMxcOpenShellDistributionAuthority(
      MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    );

    expect(authority).toMatchObject({
      acceptance: "qualification",
      profileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    });
    expect(resolveMxcOpenShellDistributionAuthority(authority)).toMatchObject({
      acceptance: "qualification",
      distributionProfileId: MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
    });
  });

  it("rejects an unknown distribution profile before observation (#10583)", () => {
    expect(() =>
      createMxcOpenShellDistributionAuthority(
        "openshell-observed-locally" as MxcOpenShellDistributionProfileId,
      ),
    ).toThrow(/distribution profile is not provider-owned/u);
  });

  it("rejects caller-constructed distribution authority before observation (#10583)", () => {
    const authority = mxcOpenShellDistributionTestFixture().authority;
    expect(() => resolveMxcOpenShellDistributionAuthority({ ...authority })).toThrow(
      /distribution authority is not provider-owned/u,
    );
  });

  it.each([
    [
      "distribution package",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as { distribution: { sha256: string } };
        observed.distribution.sha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell CLI",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as { components: { cliSha256: string } };
        observed.components.cliSha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell gateway",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as { components: { gatewaySha256: string } };
        observed.components.gatewaySha256 = "6".repeat(64);
      },
    ],
    [
      "wxc-exec",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as { components: { wxcExecSha256: string } };
        observed.components.wxcExecSha256 = "6".repeat(64);
      },
    ],
    [
      "gateway configuration",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as { gateway: { configSha256: string } };
        observed.gateway.configSha256 = "6".repeat(64);
      },
    ],
  ])("rejects %s identity drift before attachment (#8178)", (_label, mutate) => {
    const { authority, observation: fixtureObservation } = mxcOpenShellAttachmentFixture();
    const observation = structuredClone(fixtureObservation);
    mutate(observation);

    expect(() => qualifyMxcOpenShellAttachment(authority, observation)).toThrow(
      /observed distribution identity does not match/u,
    );
  });

  it("rejects components from another distribution root (#8178)", () => {
    const { authority, observation: fixtureObservation } = mxcOpenShellAttachmentFixture();
    const observation = structuredClone(fixtureObservation);
    const observed = observation as unknown as { gatewayPath: string };
    observed.gatewayPath = "C:\\OtherOpenShell\\openshell-gateway.exe";

    expect(() => qualifyMxcOpenShellAttachment(authority, observation)).toThrow(
      /gateway path must remain inside the observed distribution root/u,
    );
  });

  it("rejects wxc-exec from outside the observed MXC root (#8178)", () => {
    const { authority, observation: fixtureObservation } = mxcOpenShellAttachmentFixture();
    const observation = structuredClone(fixtureObservation);
    const observed = observation as unknown as { wxcExecPath: string };
    observed.wxcExecPath = "C:\\OtherMxc\\wxc-exec.exe";

    expect(() => qualifyMxcOpenShellAttachment(authority, observation)).toThrow(
      /wxc-exec path must remain inside the observed MXC root/u,
    );
  });

  it.each([
    ["distribution root", "distributionRoot"],
    ["MXC root", "mxcRoot"],
    ["OpenShell CLI", "cliPath"],
    ["OpenShell gateway", "gatewayPath"],
    ["wxc-exec", "wxcExecPath"],
    ["gateway configuration", "gatewayConfigPath"],
  ] as const)("rejects a network %s before attachment qualification (#8178)", (_label, field) => {
    const source = mxcOpenShellAttachmentFixture();

    expect(() =>
      qualifyMxcOpenShellAttachment(source.authority, {
        ...source.observation,
        [field]: "\\\\host\\share\\component.bin",
      }),
    ).toThrow(/local-drive Windows path/u);
  });

  it("rejects an unsupported observed backend before attachment (#8178)", () => {
    const { authority, observation } = mxcOpenShellAttachmentFixture();

    expect(() =>
      qualifyMxcOpenShellAttachment(authority, {
        ...observation,
        gateway: { ...observation.gateway, backend: "isolation_session" },
      }),
    ).toThrow(/backend must be 'process_container'/u);
  });

  it("rejects credential-bearing fields instead of copying them into the receipt (#8178)", () => {
    const { authority, observation } = mxcOpenShellAttachmentFixture();
    const candidate = {
      ...structuredClone(observation),
      providerToken: "must-not-enter-attachment-receipt",
    };

    expect(() => qualifyMxcOpenShellAttachment(authority, candidate)).toThrow(
      MxcOpenShellAttachmentError,
    );
    expect(() => qualifyMxcOpenShellAttachment(authority, candidate)).toThrow(
      /unknown or missing fields/u,
    );
  });

  it("rejects a copied or caller-constructed accepted identity authority (#8178)", () => {
    const { authority, observation } = mxcOpenShellAttachmentFixture();
    const copied = { ...authority };

    expect(() => qualifyMxcOpenShellAttachment(copied, observation)).toThrow(
      /accepted identity authority is not provider-owned/u,
    );
  });

  it.each(["0.0.21-rc.1+build.2", "1.0.0-alpha.0", "1.0.0+build.2"])(
    "parses complete SemVer identity %s before rejecting version drift (#8178)",
    (version) => {
      const { authority, observation } = mxcOpenShellAttachmentFixture(version);

      expect(() => qualifyMxcOpenShellAttachment(authority, observation)).toThrow(
        /observed distribution identity does not match/u,
      );
    },
  );

  it.each(["01.0.0", "1.01.0", "1.0.01", "1.0.0-01", "1.0.0-", "1.0.0+"])(
    "rejects noncanonical SemVer identity %s (#8178)",
    (version) => {
      const { authority, observation } = mxcOpenShellAttachmentFixture(version);
      expect(() => qualifyMxcOpenShellAttachment(authority, observation)).toThrow(
        /version is invalid/u,
      );
    },
  );
});
