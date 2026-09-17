// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE,
  MXC_OPENSHELL_V0_0_24_MXC_V0_7_0_RC1_QUALIFICATION_PROFILE_ID,
  MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE,
  MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
  MxcOpenShellAttachmentError,
  createMxcOpenShellDistributionAuthority,
  createMxcOpenShellQualificationGatewayConfiguration,
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
      nativeArchitecture: "x64",
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

  it("binds the combined qualification package to provider-rendered run-local configuration (#10585)", () => {
    const profile = MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE;
    const configured = createMxcOpenShellQualificationGatewayConfiguration({
      agentPath: "C:\\openclaw\\node.exe",
      distributionRevision: profile.expectation.distribution.revision,
      distributionProfileId: profile.profileId,
      distributionVersion: profile.expectation.distribution.version,
      egressProxyPort: 18080,
      relayPath: "C:\\mxc-share\\openshell-supervisor-relay.exe",
      shareDirectory: "C:\\mxc-share",
      targetPort: 18889,
      wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
    });
    const configSha256 = createHash("sha256").update(configured.content, "utf8").digest("hex");
    const receipt = qualifyMxcOpenShellAttachment(
      resolveMxcOpenShellDistributionAuthority(configured.distributionAuthority),
      {
        distribution: profile.expectation.distribution,
        components: profile.expectation.components,
        gateway: { ...profile.expectation.gateway, configSha256 },
        distributionRoot: "C:\\OpenShell-combined",
        mxcRoot: "C:\\mxc-sdk",
        cliPath: "C:\\OpenShell-combined\\openshell.exe",
        gatewayPath: "C:\\OpenShell-combined\\openshell-gateway.exe",
        wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
        gatewayConfigPath: "C:\\qualification\\gateway.toml",
      },
    );

    expect(configured.distributionAuthority).toMatchObject({
      acceptance: "qualification",
      profileId: MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
    });
    expect(receipt.gateway.configSha256).toBe(configSha256);
    expect(receipt.acceptance).toBe("qualification");
    expect(Object.isFrozen(configured)).toBe(true);
  });

  describe.each([
    {
      name: "combined upstream",
      profileId: "openshell-windows-tip-9a0946a3-mxc-v0-8-0-qualification",
      previousProfileId: "openshell-v0-0-59-dev-925-mr108-mxc-v0-8-0-qualification",
      previousDistribution: {
        version: "0.0.59-dev.925+g28fc07191",
        revision: "28fc0719168dbc1698ee4701d6a7af2c19262be1",
        sha256: "0".repeat(64),
      },
      observation: {
        ...mxcOpenShellAttachmentFixture().observation,
        distribution: {
          version: "0.0.117-dev.153+g9a0946a3c",
          revision: "9a0946a3ccc76a6b8fdeacdf70c76feda6f16c0b",
          sha256: "e1004bd83028ce745fcbd78f7f240f65d65c3b9f1786df7a09e4704c894703f9",
        },
        components: {
          cliSha256: "05e725968c04db97a7702cd5c95bd2f1d5bfdfe003d70590a290d3fd61a848b2",
          gatewaySha256: "7c15de65fab0db48fd147fb693d4fa88cba2f36aab5095c7fa9c0908f7897e7c",
          wxcExecSha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
        },
        gateway: {
          configSha256: "6f5113f2b5d976d52da159d725f73660352f6b7108119b41d892deb5f2e2661c",
          driver: "mxc",
          backend: "process_container",
        },
      } satisfies MxcOpenShellAttachmentObservation,
    },
  ] as const)(
    "$name package",
    ({ profileId, previousProfileId, previousDistribution, observation }) => {
      it("qualifies only the pinned package as inactive ARM64 qualification authority (#10585)", () => {
        const distributionAuthority = createMxcOpenShellDistributionAuthority(profileId);
        const authority = resolveMxcOpenShellDistributionAuthority(distributionAuthority);
        expect(qualifyMxcOpenShellAttachment(authority, observation)).toMatchObject({
          acceptance: "qualification",
          distributionProfileId: profileId,
          distribution: observation.distribution,
        });
        expect(distributionAuthority).toMatchObject({
          acceptance: "qualification",
          nativeArchitecture: "arm64",
        });
        expect(Object.isFrozen(distributionAuthority)).toBe(true);
      });

      it.each(["version", "revision", "sha256"] as const)(
        "rejects a substituted distribution %s (#10585)",
        (field) => {
          const authority = resolveMxcOpenShellDistributionAuthority(
            createMxcOpenShellDistributionAuthority(profileId),
          );
          expect(() =>
            qualifyMxcOpenShellAttachment(authority, {
              ...observation,
              distribution: { ...observation.distribution, [field]: previousDistribution[field] },
            }),
          ).toThrow(/observed distribution identity does not match/u);
        },
      );

      it.each(["cliSha256", "gatewaySha256", "wxcExecSha256"] as const)(
        "rejects a substituted component %s (#10585)",
        (field) => {
          const authority = resolveMxcOpenShellDistributionAuthority(
            createMxcOpenShellDistributionAuthority(profileId),
          );
          expect(() =>
            qualifyMxcOpenShellAttachment(authority, {
              ...observation,
              components: { ...observation.components, [field]: "0".repeat(64) },
            }),
          ).toThrow(/observed distribution identity does not match/u);
        },
      );

      it("rejects the retired distribution profile (#10585)", () => {
        expect(() =>
          createMxcOpenShellDistributionAuthority(
            previousProfileId as MxcOpenShellDistributionProfileId,
          ),
        ).toThrow(/distribution profile is not provider-owned/u);
      });
    },
  );

  it("rejects caller configuration hashes instead of letting observations mint authority (#10585)", () => {
    const profile = MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE;
    expect(() =>
      createMxcOpenShellQualificationGatewayConfiguration({
        agentPath: "C:\\openclaw\\node.exe",
        distributionRevision: profile.expectation.distribution.revision,
        distributionProfileId: profile.profileId,
        distributionVersion: profile.expectation.distribution.version,
        egressProxyPort: 18080,
        relayPath: "C:\\mxc-share\\openshell-supervisor-relay.exe",
        shareDirectory: "C:\\mxc-share",
        targetPort: 18889,
        wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
        configSha256: "6".repeat(64),
      }),
    ).toThrow(/unknown or missing fields/u);
  });

  it("rejects drift from provider-rendered configuration before attachment (#10585)", () => {
    const profile = MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE;
    const configured = createMxcOpenShellQualificationGatewayConfiguration({
      agentPath: "C:\\openclaw\\node.exe",
      distributionRevision: profile.expectation.distribution.revision,
      distributionProfileId: profile.profileId,
      distributionVersion: profile.expectation.distribution.version,
      egressProxyPort: 18080,
      relayPath: "C:\\mxc-share\\openshell-supervisor-relay.exe",
      shareDirectory: "C:\\mxc-share",
      targetPort: 18889,
      wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
    });

    expect(() =>
      qualifyMxcOpenShellAttachment(
        resolveMxcOpenShellDistributionAuthority(configured.distributionAuthority),
        {
          distribution: profile.expectation.distribution,
          components: profile.expectation.components,
          gateway: {
            ...profile.expectation.gateway,
            configSha256: "6".repeat(64),
          },
          distributionRoot: "C:\\OpenShell-combined",
          mxcRoot: "C:\\mxc-sdk",
          cliPath: "C:\\OpenShell-combined\\openshell.exe",
          gatewayPath: "C:\\OpenShell-combined\\openshell-gateway.exe",
          wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
          gatewayConfigPath: "C:\\qualification\\gateway.toml",
        },
      ),
    ).toThrow(/observed distribution identity does not match/u);
  });

  it.each([
    ["openshell-not-provider-owned", /profile is not provider-owned/u],
    [
      MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
      /does not match the provider-owned profile/u,
    ],
  ])(
    "rejects invalid qualification distribution %s before observation (#10585)",
    (profileId, error) => {
      expect(() =>
        createMxcOpenShellQualificationGatewayConfiguration({
          agentPath: "C:\\openclaw\\node.exe",
          distributionRevision: "abcdef0123456789",
          distributionProfileId: profileId,
          distributionVersion: "9.9.9-dev.1",
          egressProxyPort: 18080,
          relayPath: "C:\\mxc-share\\openshell-supervisor-relay.exe",
          shareDirectory: "C:\\mxc-share",
          targetPort: 18889,
          wxcExecPath: "C:\\mxc-sdk\\bin\\arm64\\wxc-exec.exe",
        }),
      ).toThrow(error);
    },
  );

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
        const observed = observation as unknown as {
          distribution: { sha256: string };
        };
        observed.distribution.sha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell CLI",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as {
          components: { cliSha256: string };
        };
        observed.components.cliSha256 = "6".repeat(64);
      },
    ],
    [
      "OpenShell gateway",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as {
          components: { gatewaySha256: string };
        };
        observed.components.gatewaySha256 = "6".repeat(64);
      },
    ],
    [
      "wxc-exec",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as {
          components: { wxcExecSha256: string };
        };
        observed.components.wxcExecSha256 = "6".repeat(64);
      },
    ],
    [
      "gateway configuration",
      (observation: MxcOpenShellAttachmentObservation) => {
        const observed = observation as unknown as {
          gateway: { configSha256: string };
        };
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
