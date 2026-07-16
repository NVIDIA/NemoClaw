// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readOpenShellGatewayUpgradeWorkflow,
  validateOpenShellGatewayUpgradeWorkflow,
} from "../../../tools/e2e/openshell-gateway-upgrade-workflow-boundary.mts";
import {
  validateE2eWorkflow,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import {
  currentGatewayUpgradeInstallerArgs,
  oldGatewayUpgradeInstallerArgs,
  upgradeGatewayCleanupScript,
  validateLegacyGatewayUpgradeFixture,
} from "../live/openshell-gateway-upgrade-helpers.ts";

describe("OpenShell gateway upgrade workflow boundary", () => {
  it("pins architecture and immediate-predecessor fixtures to the canonical live test (#6114)", () => {
    const workflow = readOpenShellGatewayUpgradeWorkflow();
    expect(validateOpenShellGatewayUpgradeWorkflow(workflow)).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);

    const job = (workflow.jobs as Record<string, Record<string, unknown>>)[
      "openshell-gateway-upgrade"
    ];
    job["runs-on"] = "ubuntu-latest";
    const strategy = job.strategy as Record<string, Record<string, unknown>>;
    const fixtures = strategy.matrix.include as Array<Record<string, unknown>>;
    fixtures.find((fixture) => fixture.id === "v0.0.55-x86_64")!.sandbox_base_image_ref =
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6";
    fixtures.find((fixture) => fixture.id === "v0.0.55-aarch64")!.runner = "ubuntu-latest";
    fixtures.find((fixture) => fixture.id === "v0.0.74-x86_64")!.openclaw_version = "latest";
    (job.env as Record<string, unknown>).NEMOCLAW_E2E_SHARD = "default";
    const run = (job.steps as Array<Record<string, unknown>>).find(
      (step) => step.name === "Run OpenShell gateway upgrade live Vitest test",
    )!;
    run.run = "npx vitest run --project e2e-live unrelated.test.ts";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-gateway-upgrade must run on ${{ matrix.runner }}",
        "openshell-gateway-upgrade v0.0.55 matrix must pin x86_64 and arm64 upgrade fixtures",
        "openshell-gateway-upgrade matrix must pin the immediate v0.0.74 x86_64 upgrade fixture",
        "openshell-gateway-upgrade must publish one risk-signal shard per legacy fixture",
        "openshell-gateway-upgrade step 'Run OpenShell gateway upgrade live Vitest test' must run: npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-upgrade.test.ts",
      ]),
    );
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
