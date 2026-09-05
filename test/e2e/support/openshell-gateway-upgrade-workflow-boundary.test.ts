// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogueTarget,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import {
  currentGatewayUpgradeInstallerArgs,
  currentNemoclawUpgradeRef,
  expectedLegacyRegistryMetadata,
  GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  legacyGatewayUpgradeHostFirewallOptions,
  oldGatewayUpgradeInstallerArgs,
  throwGatewayUpgradeSetupFailures,
  upgradeGatewayCleanupScript,
  validateLegacyGatewayUpgradeFixture,
} from "../live/openshell-gateway-upgrade-helpers.ts";

describe("OpenShell gateway upgrade boundary", () => {
  it("pins architecture and immediate-predecessor fixtures in the catalogue (#6114)", () => {
    const fixtures = [
      catalogueTarget("openshell-gateway-upgrade-v0-0-36-x86-64"),
      catalogueTarget("openshell-gateway-upgrade-v0-0-55-x86-64"),
      catalogueTarget("openshell-gateway-upgrade-v0-0-55-aarch64"),
      catalogueTarget("openshell-gateway-upgrade-v0-0-74-x86-64"),
      catalogueTarget("openshell-gateway-upgrade-v0-0-89-x86-64"),
    ];

    expect(
      fixtures.map(({ environment, runner, shard }) => ({
        runner,
        shard,
        nemoclawRef: environment.NEMOCLAW_OLD_NEMOCLAW_REF,
        commit: environment.NEMOCLAW_OLD_NEMOCLAW_COMMIT,
        installerSha256: environment.NEMOCLAW_OLD_INSTALLER_SHA256,
        sandboxBaseImageRef: environment.NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF,
        openShellVersion: environment.NEMOCLAW_OLD_OPENSHELL_VERSION,
        openClawVersion: environment.NEMOCLAW_OLD_OPENCLAW_VERSION,
        currentOpenClawVersion: environment.NEMOCLAW_CURRENT_OPENCLAW_VERSION,
        stateUpgradeProof: environment.NEMOCLAW_OPENCLAW_STATE_UPGRADE_PROOF,
      })),
    ).toEqual([
      {
        runner: "ubuntu-latest",
        shard: "v0-0-36-x86-64",
        nemoclawRef: "v0.0.36",
        commit: "3351fbdd4eb7d9b80ec471545083956327da2b10",
        installerSha256: "0c42400a0d3867739f1d75d612e069967be4506e169974bbbebf14b7af39144f",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
        openShellVersion: "0.0.36",
        openClawVersion: "2026.4.24",
        currentOpenClawVersion: "",
        stateUpgradeProof: "",
      },
      {
        runner: "ubuntu-latest",
        shard: "v0-0-55-x86-64",
        nemoclawRef: "v0.0.55",
        commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
        installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
        openShellVersion: "0.0.44",
        openClawVersion: "2026.5.22",
        currentOpenClawVersion: "",
        stateUpgradeProof: "",
      },
      {
        runner: "ubuntu-24.04-arm",
        shard: "v0-0-55-aarch64",
        nemoclawRef: "v0.0.55",
        commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
        installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
        openShellVersion: "0.0.44",
        openClawVersion: "2026.5.22",
        currentOpenClawVersion: "",
        stateUpgradeProof: "",
      },
      {
        runner: "ubuntu-latest",
        shard: "v0-0-74-x86-64",
        nemoclawRef: "v0.0.74",
        commit: "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
        installerSha256: "a0cd3feca488d247e53d59d7d8246d2b86e75e95acb5e7d78504b3c0c60fd7db",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
        openShellVersion: "0.0.72",
        openClawVersion: "2026.5.27",
        currentOpenClawVersion: "",
        stateUpgradeProof: "",
      },
      {
        runner: "ubuntu-latest",
        shard: "v0-0-89-x86-64",
        nemoclawRef: "v0.0.89",
        commit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
        installerSha256: "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
        openShellVersion: "0.0.85",
        openClawVersion: "2026.6.10",
        currentOpenClawVersion: "2026.7.1",
        stateUpgradeProof: "1",
      },
    ]);
  });

  it("rejects reintroducing the superseded workflow job", () => {
    const workflow = readWorkflow() as { jobs: Record<string, unknown> };
    workflow.jobs["openshell-gateway-upgrade"] = {};

    expect(validateE2eWorkflow(workflow)).toContain(
      "workflow must not define superseded openshell-gateway-upgrade job",
    );
  });

  it("rejects drift from every exact reviewed gateway-upgrade fixture field (#6114)", () => {
    const fixture = catalogueTarget("openshell-gateway-upgrade-v0-0-55-x86-64");
    const mutations = [
      { runner: "ubuntu-24.04-arm" },
      { shard: "v0-0-55-aarch64" },
      { environment: { ...fixture.environment, NEMOCLAW_OLD_OPENSHELL_VERSION: "0.0.45" } },
      { environment: { ...fixture.environment, NEMOCLAW_OLD_INSTALLER_SHA256: "0".repeat(64) } },
      {
        environment: {
          ...fixture.environment,
          NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF: `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${"0".repeat(64)}`,
        },
      },
    ];

    mutations.forEach((mutation) => {
      expect(() => validateE2eTargetCatalogue([{ ...fixture, ...mutation }])).toThrow(
        /exact reviewed gateway-upgrade fixture/,
      );
    });
  });

  it("freshens only the retryable old fixture install", () => {
    expect(oldGatewayUpgradeInstallerArgs("old-install.sh")).toEqual([
      "old-install.sh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
      "--fresh",
    ]);
    expect(currentGatewayUpgradeInstallerArgs("current-install.sh")).toEqual([
      "current-install.sh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
    ]);
    expect(currentGatewayUpgradeInstallerArgs("current-install.sh", { interactive: true })).toEqual(
      ["current-install.sh"],
    );
  });

  it("installs the selected E2E checkout instead of the trusted workflow SHA", () => {
    expect(
      currentNemoclawUpgradeRef({
        NEMOCLAW_E2E_EXPECTED_SHA: "candidate-sha",
        GITHUB_SHA: "trusted-main-sha",
      }),
    ).toBe("candidate-sha");
    expect(
      currentNemoclawUpgradeRef({
        NEMOCLAW_CURRENT_NEMOCLAW_REF: "explicit-ref",
        NEMOCLAW_E2E_EXPECTED_SHA: "candidate-sha",
        GITHUB_SHA: "trusted-main-sha",
      }),
    ).toBe("explicit-ref");
    expect(currentNemoclawUpgradeRef({ GITHUB_SHA: "workflow-sha" })).toBe("workflow-sha");
    expect(
      currentNemoclawUpgradeRef({ NEMOCLAW_E2E_EXPECTED_SHA: "", GITHUB_SHA: "workflow-sha" }),
    ).toBe("workflow-sha");
    expect(currentNemoclawUpgradeRef({})).toBe("HEAD");
  });

  it.each(["v0.0.55", "v0.0.74", "v0.0.89", "v0.0.115"])(
    "waits through the historical install for each gateway network [%s]",
    (nemoclawRef) => {
      expect(legacyGatewayUpgradeHostFirewallOptions("v0.0.36")).toEqual({
        networkName: "openshell-cluster-nemoclaw",
        waitForNetworkMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
      });

      expect(legacyGatewayUpgradeHostFirewallOptions(nemoclawRef)).toEqual({
        networkName: undefined,
        waitForNetworkMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
      });

      expect(() => legacyGatewayUpgradeHostFirewallOptions("v0.0.90")).toThrow(
        /Unsupported gateway-upgrade network fixture/,
      );
    },
  );

  it("accepts successful legacy install and firewall setup results (#8696)", () => {
    expect(() =>
      throwGatewayUpgradeSetupFailures([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]),
    ).not.toThrow();
  });

  it("preserves one legacy setup failure (#8696)", () => {
    const failure = new Error("firewall setup failed");
    expect(() =>
      throwGatewayUpgradeSetupFailures([
        { status: "fulfilled", value: undefined },
        { reason: failure, status: "rejected" },
      ]),
    ).toThrow(failure);
  });

  it("aggregates concurrent legacy setup failures (#8696)", () => {
    const installFailure = new Error("legacy install failed");
    const firewallFailure = new Error("firewall setup failed");
    expect(() =>
      throwGatewayUpgradeSetupFailures([
        { reason: installFailure, status: "rejected" },
        { reason: firewallFailure, status: "rejected" },
      ]),
    ).toThrow(
      expect.objectContaining({
        errors: [installFailure, firewallFailure],
        message: "legacy install and host mock firewall setup failed",
      }),
    );
  });

  it("pins the registry metadata written by each historical release fixture", () => {
    const absentMetadata = { nemoclawVersion: undefined, fromDockerfile: undefined };
    expect(expectedLegacyRegistryMetadata("v0.0.36")).toEqual(absentMetadata);
    expect(expectedLegacyRegistryMetadata("v0.0.55")).toEqual(absentMetadata);
    expect(expectedLegacyRegistryMetadata("v0.0.74")).toEqual({
      nemoclawVersion: "0.0.74",
      fromDockerfile: null,
    });
    expect(expectedLegacyRegistryMetadata("v0.0.89")).toEqual({
      nemoclawVersion: "0.0.89",
      fromDockerfile: null,
    });
    expect(() => expectedLegacyRegistryMetadata("v0.0.90")).toThrow(
      /Unsupported gateway-upgrade registry fixture/,
    );
  });

  it("rejects mutable or injectable historical fixture inputs before use (#6114)", () => {
    const fixture = {
      nemoclawRef: "v0.0.55",
      nemoclawCommit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
      installerSha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
      openclawVersion: "2026.5.22",
      sandboxBaseImageRef:
        "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    };

    expect(validateLegacyGatewayUpgradeFixture(fixture)).toEqual({
      sandboxBaseDigest: "10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    });
    expect(
      validateLegacyGatewayUpgradeFixture({
        nemoclawRef: "v0.0.89",
        nemoclawCommit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
        installerSha256: "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2",
        openclawVersion: "2026.6.10",
        sandboxBaseImageRef:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
      }),
    ).toEqual({
      sandboxBaseDigest: "3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
    });
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawCommit: "3351fbdd4eb7d9b80ec471545083956327da2b10",
      }),
    ).toThrow(/exact reviewed ref\/commit\/OpenClaw profile/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        openclawVersion: "2026.4.24",
      }),
    ).toThrow(/exact reviewed ref\/commit\/OpenClaw profile/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawRef: "v0.0.36",
      }),
    ).toThrow(/exact reviewed ref\/commit\/OpenClaw profile/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawRef: "v0.0.55; echo injected",
      }),
    ).toThrow(/NEMOCLAW_OLD_NEMOCLAW_REF/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        nemoclawCommit: fixture.nemoclawCommit.toUpperCase(),
      }),
    ).toThrow(/NEMOCLAW_OLD_NEMOCLAW_COMMIT/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        installerSha256: fixture.installerSha256.toUpperCase(),
      }),
    ).toThrow(/NEMOCLAW_OLD_INSTALLER_SHA256/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        openclawVersion: '2026.5.22" && echo injected #',
      }),
    ).toThrow(/NEMOCLAW_OLD_OPENCLAW_VERSION/);
    expect(() =>
      validateLegacyGatewayUpgradeFixture({
        ...fixture,
        sandboxBaseImageRef: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      }),
    ).toThrow(/NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF/);
  });

  it("reclaims only the owned gateway volume namespace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cleanup-"));
    const log = path.join(tmp, "removed-volumes.log");
    const pidFile = path.join(tmp, "gateway.pid");
    fs.writeFileSync(pidFile, "123\n");
    const script = [
      "set -euo pipefail",
      "openshell() { return 0; }",
      "docker() {",
      '  case "${1:-} ${2:-}" in',
      '    "volume ls") printf "%s\\n" openshell-cluster-nemoclaw openshell-cluster-nemoclaw-cache openshell-cluster-nemoclaw2 unrelated ;;',
      '    "volume rm") printf "%s\\n" "${3:-}" >>"$CLEANUP_LOG" ;;',
      "    *) return 99 ;;",
      "  esac",
      "}",
      upgradeGatewayCleanupScript(pidFile),
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, CLEANUP_LOG: log },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "openshell-cluster-nemoclaw",
        "openshell-cluster-nemoclaw-cache",
      ]);
      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
