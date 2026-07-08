// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import {
  currentGatewayUpgradeInstallerArgs,
  oldGatewayUpgradeInstallerArgs,
  upgradeGatewayCleanupScript,
} from "../live/openshell-gateway-upgrade-helpers.ts";

describe("OpenShell gateway upgrade workflow boundary", () => {
  it("routes selector inputs to the free-standing E2E job", () => {
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        targets: "openshell-gateway-upgrade",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade"],
      registryTargets: [],
    });
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        jobs: "openshell-gateway-upgrade",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["openshell-gateway-upgrade"],
      registryTargets: [],
    });
  });

  it("derives the free-standing inventory metadata from the workflow", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateFreeStandingWorkflowInventory()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-gateway-upgrade");
    expect(inventory.targetToJob.get("openshell-gateway-upgrade")).toBe(
      "openshell-gateway-upgrade",
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
