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
  currentNemoclawUpgradeRef,
  expectedLegacyRegistryMetadata,
  oldGatewayUpgradeInstallerArgs,
  upgradeGatewayCleanupScript,
  validateLegacyGatewayUpgradeFixture,
} from "../live/openshell-gateway-upgrade-helpers.ts";

type GatewayTierScenario = {
  checkoutSha?: string;
  eventName: string;
  executionTier: string;
  includeStagingBrevLaunchable?: "0" | "1";
  jobs?: string;
  matrixId?: string;
  targets?: string;
  uniqueBoundary?: string;
  weekday: string;
};

function runGatewayTierClassifier(scenario: GatewayTierScenario): Record<string, string> {
  const workflow = readOpenShellGatewayUpgradeWorkflow();
  const job = (workflow.jobs as Record<string, Record<string, unknown>>)[
    "openshell-gateway-upgrade"
  ];
  const steps = job.steps as Array<Record<string, unknown>>;
  const classify = steps.find(
    (step) => step.name === "Classify OpenShell gateway upgrade coverage tier",
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tier-"));
  const fakeDate = path.join(tempDir, "date");
  const outputPath = path.join(tempDir, "github-output");
  const summaryPath = path.join(tempDir, "summary.md");
  fs.writeFileSync(
    fakeDate,
    [
      "#!/usr/bin/env bash",
      'if [[ "${1:-}" == "-u" && "${2:-}" == "+%u" ]]; then',
      '  printf "%s\\n" "${FAKE_DAY_OF_WEEK}"',
      "else",
      '  /bin/date "$@"',
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["-c", String(classify?.run)], {
      encoding: "utf8",
      env: {
        ...process.env,
        CHECKOUT_SHA: scenario.checkoutSha ?? "",
        EVENT_NAME: scenario.eventName,
        EXECUTION_TIER: scenario.executionTier,
        FAKE_DAY_OF_WEEK: scenario.weekday,
        GATEWAY_UPGRADE_NIGHTLY_ROWS: "1",
        GATEWAY_UPGRADE_RETAINED_ROWS: "5",
        GATEWAY_UPGRADE_ROW_TIMEOUT_MINUTES: "70",
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        INCLUDE_STAGING_BREV_LAUNCHABLE: scenario.includeStagingBrevLaunchable ?? "0",
        JOBS: scenario.jobs ?? "",
        MATRIX_ID: scenario.matrixId ?? "v0.0.55-x86_64",
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        TARGETS: scenario.targets ?? "",
        UNIQUE_BOUNDARY: scenario.uniqueBoundary ?? "OpenShell 0.0.44 gateway migration on x86_64",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      fs
        .readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [key, ...value] = line.split("=");
          return [key, value.join("=")];
        }),
    );
    outputs.summary = fs.readFileSync(summaryPath, "utf8");
    return outputs;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

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
    fixtures.find((fixture) => fixture.id === "v0.0.89-x86_64")!.openclaw_state_upgrade = "0";
    const env = job.env as Record<string, unknown>;
    env.NEMOCLAW_E2E_SHARD = "default";
    env.NEMOCLAW_CURRENT_OPENCLAW_VERSION = "latest";
    env.NEMOCLAW_OPENCLAW_STATE_UPGRADE_PROOF = "0";
    const run = (job.steps as Array<Record<string, unknown>>).find(
      (step) => step.name === "Run OpenShell gateway upgrade live Vitest test",
    )!;
    run.run = "npx vitest run --project e2e-live unrelated.test.ts";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-gateway-upgrade must run on ${{ matrix.runner }}",
        "openshell-gateway-upgrade v0.0.55 matrix must pin x86_64 and arm64 upgrade fixtures",
        "openshell-gateway-upgrade matrix must pin the immediate v0.0.74 x86_64 upgrade fixture",
        "openshell-gateway-upgrade matrix must pin the v0.0.89 OpenClaw state-upgrade fixture",
        "openshell-gateway-upgrade must publish one risk-signal shard per legacy fixture",
        "openshell-gateway-upgrade must bind the current OpenClaw version from its fixture",
        "openshell-gateway-upgrade must bind the OpenClaw state-upgrade proof flag from its fixture",
        "openshell-gateway-upgrade step 'Run OpenShell gateway upgrade live Vitest test' must run: npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-upgrade.test.ts",
      ]),
    );
  });

  it("documents retained gateway upgrade execution tiers (#7920)", () => {
    const workflow = readOpenShellGatewayUpgradeWorkflow();
    const job = (workflow.jobs as Record<string, Record<string, unknown>>)[
      "openshell-gateway-upgrade"
    ];
    const strategy = job.strategy as Record<string, Record<string, unknown>>;
    const fixtures = strategy.matrix.include as Array<Record<string, unknown>>;
    expect(
      fixtures.map((fixture) => ({
        execution_tier: fixture.execution_tier,
        id: fixture.id,
        unique_boundary: fixture.unique_boundary,
      })),
    ).toEqual([
      {
        execution_tier: "weekly-release",
        id: "v0.0.36-x86_64",
        unique_boundary: "oldest-supported OpenShell/NemoClaw gateway migration baseline",
      },
      {
        execution_tier: "weekly-release",
        id: "v0.0.55-x86_64",
        unique_boundary: "OpenShell 0.0.44 gateway migration on x86_64",
      },
      {
        execution_tier: "weekly-release",
        id: "v0.0.55-aarch64",
        unique_boundary: "OpenShell 0.0.44 gateway migration on arm64",
      },
      {
        execution_tier: "weekly-release",
        id: "v0.0.74-x86_64",
        unique_boundary: "immediate-predecessor OpenShell 0.0.72 gateway migration",
      },
      {
        execution_tier: "nightly",
        id: "v0.0.89-x86_64",
        unique_boundary: "current OpenClaw state-upgrade gateway migration",
      },
    ]);

    const steps = job.steps as Array<Record<string, unknown>>;
    const classify = steps.find(
      (step) => step.name === "Classify OpenShell gateway upgrade coverage tier",
    );
    expect(classify).toMatchObject({
      env: expect.objectContaining({
        CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
        EVENT_NAME: "${{ github.event_name }}",
        EXECUTION_TIER: "${{ matrix.execution_tier }}",
        GATEWAY_UPGRADE_NIGHTLY_ROWS: "1",
        GATEWAY_UPGRADE_RETAINED_ROWS: "5",
        GATEWAY_UPGRADE_ROW_TIMEOUT_MINUTES: "70",
        INCLUDE_STAGING_BREV_LAUNCHABLE:
          "${{ inputs.include_staging_brev_launchable && '1' || '0' }}",
        JOBS: "${{ inputs.jobs }}",
        MATRIX_ID: "${{ matrix.id }}",
        TARGETS: "${{ inputs.targets }}",
        UNIQUE_BOUNDARY: "${{ matrix.unique_boundary }}",
      }),
      id: "gateway_upgrade_tier",
    });
    const classifyRun = String(classify?.run);
    expect(classifyRun).toContain("date -u +%u");
    expect(classifyRun).toContain("explicit-selection");
    expect(classifyRun).toContain("weekly-retained");
    expect(classifyRun).toContain("release-qualification");
    expect(classifyRun).toContain("skipped-by-tier");
    expect(classifyRun).toContain("expected_nightly_runner_minute_reduction");
    expect(classifyRun).toContain("observed_nightly_runner_minute_reduction");
    expect(classifyRun).toContain("Expected nightly runner-minute reduction");
    expect(classifyRun).toContain("Observed nightly runner-minute reduction");
    expect(classifyRun).toContain("GITHUB_STEP_SUMMARY");

    expect(steps.find((step) => step.name === "Prepare E2E workspace")?.if).toBe(
      "${{ steps.gateway_upgrade_tier.outputs.run == '1' }}",
    );
    expect(
      steps.find((step) => step.name === "Run OpenShell gateway upgrade live Vitest test")?.if,
    ).toBe("${{ steps.gateway_upgrade_tier.outputs.run == '1' }}");
    expect(
      steps.find((step) => step.name === "Upload OpenShell gateway upgrade artifacts")?.if,
    ).toBe("${{ always() && steps.gateway_upgrade_tier.outputs.run == '1' }}");
    const skipped = steps.find(
      (step) => step.name === "Record skipped OpenShell gateway upgrade row",
    );
    expect(skipped?.if).toBe("${{ steps.gateway_upgrade_tier.outputs.run != '1' }}");
    expect(String(skipped?.run)).toContain("skipped-by-tier");
  });

  it.each([
    {
      expected: { observed: "0", reason: "explicit-selection", run: "1" },
      name: "explicit jobs selection",
      scenario: {
        eventName: "workflow_dispatch",
        executionTier: "weekly-release",
        includeStagingBrevLaunchable: "1",
        jobs: "openshell-gateway-upgrade",
        weekday: "7",
      },
    },
    {
      expected: { observed: "0", reason: "explicit-selection", run: "1" },
      name: "explicit targets selection",
      scenario: {
        eventName: "workflow_dispatch",
        executionTier: "weekly-release",
        targets: "openshell-gateway-upgrade",
        weekday: "1",
      },
    },
    {
      expected: { observed: "0", reason: "explicit-selection", run: "1" },
      name: "owning-file PR selection",
      scenario: {
        checkoutSha: "candidate-sha",
        eventName: "workflow_dispatch",
        executionTier: "weekly-release",
        jobs: "openshell-gateway-upgrade",
        weekday: "1",
      },
    },
    {
      expected: { observed: "0", reason: "nightly-canonical", run: "1" },
      name: "nightly canonical row",
      scenario: { eventName: "schedule", executionTier: "nightly", weekday: "1" },
    },
    {
      expected: { observed: "0", reason: "weekly-retained", run: "1" },
      name: "Sunday retained row",
      scenario: { eventName: "schedule", executionTier: "weekly-release", weekday: "7" },
    },
    {
      expected: { observed: "70", reason: "skipped-by-tier", run: "0" },
      name: "non-Sunday retained row",
      scenario: { eventName: "schedule", executionTier: "weekly-release", weekday: "1" },
    },
    {
      expected: { observed: "0", reason: "release-qualification", run: "1" },
      name: "release qualification",
      scenario: {
        eventName: "workflow_dispatch",
        executionTier: "weekly-release",
        includeStagingBrevLaunchable: "1",
        weekday: "1",
      },
    },
  ])("classifies $name gateway upgrade tier decisions (#7920)", ({ expected, scenario }) => {
    const outputs = runGatewayTierClassifier(scenario as GatewayTierScenario);

    expect(outputs).toMatchObject({
      baseline_nightly_runner_minutes: "350",
      expected_nightly_runner_minute_reduction: "280",
      observed_nightly_runner_minute_reduction: expected.observed,
      reason: expected.reason,
      run: expected.run,
      tiered_nightly_runner_minutes: "70",
    });
    expect(outputs.summary).toContain(
      "Expected nightly runner-minute reduction: `280` max runner-minutes (80%)",
    );
    expect(outputs.summary).toContain(
      `Observed nightly runner-minute reduction for this row: \`${expected.observed}\` max runner-minutes`,
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
