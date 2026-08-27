// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MxcOpenShellAttachmentError,
  createMxcOpenShellAttachmentAuthority,
  qualifyMxcOpenShellAttachment,
  type MxcOpenShellAttachmentObservation,
} from "./mxc-openshell-attachment";
import {
  MXC_OPENSHELL_ATTACHMENT_TEST_DIGESTS as DIGESTS,
  mxcOpenShellAttachmentFixture,
} from "./mxc-openshell-attachment-test-fixture";

describe("inactive OpenShell MXC installation attachment", () => {
  it("binds one accepted distribution and gateway configuration without installing it (#8178)", () => {
    const { authority, observation } = mxcOpenShellAttachmentFixture();
    const receipt = qualifyMxcOpenShellAttachment(authority, observation);

    expect(authority).toEqual({
      contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
      providerId: "mxc",
      mode: "attach-existing",
      acceptedIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(authority)).toBe(true);
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

  it("rejects an unsupported backend before attachment (#8178)", () => {
    const { observation } = mxcOpenShellAttachmentFixture();
    const accepted = {
      distribution: observation.distribution,
      components: observation.components,
      gateway: { ...observation.gateway, backend: "isolation_session" },
    };

    expect(() => createMxcOpenShellAttachmentAuthority(accepted)).toThrow(
      /backend must be 'process_container'/u,
    );
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

  it("retains an owned accepted identity after the caller mutates its input (#8178)", () => {
    const { observation } = mxcOpenShellAttachmentFixture();
    const accepted = {
      distribution: { ...observation.distribution },
      components: { ...observation.components },
      gateway: { ...observation.gateway },
    };
    const authority = createMxcOpenShellAttachmentAuthority(accepted);

    accepted.components.gatewaySha256 = "6".repeat(64);

    expect(qualifyMxcOpenShellAttachment(authority, observation).components.gateway.sha256).toBe(
      DIGESTS.gateway,
    );
  });

  it.each(["0.0.21-rc.1+build.2", "1.0.0-alpha.0", "1.0.0+build.2"])(
    "accepts complete SemVer identity %s (#8178)",
    (version) => {
      const { authority, observation } = mxcOpenShellAttachmentFixture(version);

      expect(qualifyMxcOpenShellAttachment(authority, observation).distribution.version).toBe(
        version,
      );
    },
  );

  it.each(["01.0.0", "1.01.0", "1.0.01", "1.0.0-01", "1.0.0-", "1.0.0+"])(
    "rejects noncanonical SemVer identity %s (#8178)",
    (version) => {
      expect(() => mxcOpenShellAttachmentFixture(version)).toThrow(/version is invalid/u);
    },
  );
});
