// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RETIRED_CONTROLLER_SELECTOR_IDS,
  runRetiredSelectorCompatibility,
  selectedRetiredControllerJobs,
} from "../../../tools/e2e/retired-selector-compatibility.mts";

const EXPECTED_SHA = "a".repeat(40);
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const REPLACEMENT_FILES = [
  "src/lib/actions/sandbox/rebuild-flow-helpers.test.ts",
  "src/lib/actions/sandbox/rebuild-post-restore-phase.test.ts",
  "src/lib/actions/sandbox/rebuild-recreate-observability.test.ts",
  "src/lib/actions/sandbox/rebuild-route-preflight.test.ts",
  "src/lib/actions/upgrade-sandboxes-recovery.test.ts",
  "src/lib/sandbox/version.test.ts",
  "src/lib/security/credential-filter.test.ts",
  "test/cli/list-share-live-inference.test.ts",
  "test/credentials/credential-migration-reconciliation.test.ts",
  "test/package-contract/cli/debug-cli-command.test.ts",
  "test/package-contract/cli/public-cli-contracts.test.ts",
  "test/runtime/gateway/gateway-drift-preflight.test.ts",
  "test/runtime/gateway/gateway-health-honest.test.ts",
  "test/credentials/credentials.test.ts",
  "test/package-contract/onboard/invalid-nvidia-key.test.ts",
  "test/installer-integration/install-openshell-version-pin.test.ts",
  "test/process-recovery/rebuild-stale-recovery.test.ts",
] as const;

function workspace(): { artifactRoot: string; output: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retired-selector-"));
  for (const file of REPLACEMENT_FILES) {
    const fullPath = path.join(root, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "export {};\n", "utf8");
  }
  return {
    artifactRoot: path.join(root, "artifacts"),
    output: path.join(root, "github-output"),
    root,
  };
}

function environment(
  target: ReturnType<typeof workspace>,
  jobs: string,
  targets = "",
): NodeJS.ProcessEnv {
  return {
    E2E_ARTIFACT_DIR: target.artifactRoot,
    GITHUB_OUTPUT: target.output,
    GITHUB_WORKSPACE: target.root,
    JOBS: jobs,
    TARGETS: targets,
    NEMOCLAW_E2E_CORRELATION_ID: CORRELATION_ID,
    NEMOCLAW_E2E_EXPECTED_SHA: EXPECTED_SHA,
    NEMOCLAW_E2E_SHARD: "default",
  };
}

describe("retired E2E selector compatibility", () => {
  it("selects only IDs absent from an SHA-bound candidate inventory (#7616)", () => {
    expect(
      selectedRetiredControllerJobs({
        allowedJobs: ["cloud-onboard", "credential-sanitization", "docs-validation"],
        expectedSha: EXPECTED_SHA,
        jobs: "cloud-onboard,credential-sanitization,diagnostics,docs-validation,gateway-health-honest",
      }),
    ).toEqual(["diagnostics", "gateway-health-honest"]);
    expect(
      selectedRetiredControllerJobs({
        allowedJobs: ["cloud-onboard"],
        jobs: "cloud-onboard,gateway-health-honest",
      }),
    ).toEqual([]);
    expect(
      selectedRetiredControllerJobs({
        allowedJobs: ["cloud-onboard"],
        expectedSha: EXPECTED_SHA,
        jobs: "sandbox-rebuild",
        targets: "diagnostics,sandbox-rebuild,upgrade-stale-sandbox",
      }),
    ).toEqual(["sandbox-rebuild", "upgrade-stale-sandbox"]);
  });

  it("runs each ordinary replacement project once and emits bound signals (#7616)", () => {
    const target = workspace();
    const commands: string[] = [];
    const suppliedEnvironment = environment(
      target,
      ["cloud-onboard", ...RETIRED_CONTROLLER_SELECTOR_IDS].join(","),
    );
    try {
      const selected = runRetiredSelectorCompatibility(suppliedEnvironment, {
        allowedJobs: ["cloud-onboard"],
        repositoryRoot: target.root,
        resolveHead: () => EXPECTED_SHA,
        runCommand: (command, args, _cwd, commandEnvironment) => {
          expect(commandEnvironment).toBe(suppliedEnvironment);
          commands.push([command, ...args].join(" "));
        },
      });

      expect(selected).toEqual([...RETIRED_CONTROLLER_SELECTOR_IDS].sort());
      expect(commands).toEqual([
        "npx vitest run --project cli src/lib/actions/sandbox/rebuild-flow-helpers.test.ts src/lib/actions/sandbox/rebuild-post-restore-phase.test.ts src/lib/actions/sandbox/rebuild-recreate-observability.test.ts src/lib/actions/sandbox/rebuild-route-preflight.test.ts src/lib/actions/upgrade-sandboxes-recovery.test.ts src/lib/sandbox/version.test.ts src/lib/security/credential-filter.test.ts",
        "npx vitest run --project integration test/cli/list-share-live-inference.test.ts test/credentials/credential-migration-reconciliation.test.ts test/credentials/credentials.test.ts test/runtime/gateway/gateway-drift-preflight.test.ts test/runtime/gateway/gateway-health-honest.test.ts test/process-recovery/rebuild-stale-recovery.test.ts",
        "npx vitest run --project installer-integration test/installer-integration/install-openshell-version-pin.test.ts",
        "npx vitest run --project package-contract test/package-contract/cli/debug-cli-command.test.ts test/package-contract/cli/public-cli-contracts.test.ts test/package-contract/onboard/invalid-nvidia-key.test.ts",
      ]);
      expect(fs.readFileSync(target.output, "utf8")).toBe("selected=true\n");
      selected.forEach((id) => {
        const signalPath = path.join(target.artifactRoot, id, "risk-signal.json");
        expect(JSON.parse(fs.readFileSync(signalPath, "utf8"))).toEqual({
          version: 1,
          jobId: id,
          shardId: "default",
          expectedSha: EXPECTED_SHA,
          testedSha: EXPECTED_SHA,
          correlationId: CORRELATION_ID,
          passed: 1,
          failed: 0,
          skipped: 0,
          pending: 0,
          unhandledErrors: 0,
          runReason: "passed",
        });
        expect(fs.statSync(signalPath).mode & 0o777).toBe(0o600);
      });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(target.artifactRoot, "retired-selector-compatibility.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ schemaVersion: 1, status: "passed", selected });
    } finally {
      fs.rmSync(target.root, { force: true, recursive: true });
    }
  });

  it("runs and reports both rebuild replacements selected through targets (#7615)", () => {
    const target = workspace();
    const commands: string[] = [];
    const suppliedEnvironment = environment(target, "", "sandbox-rebuild,upgrade-stale-sandbox");
    try {
      const selected = runRetiredSelectorCompatibility(suppliedEnvironment, {
        allowedJobs: ["cloud-onboard"],
        repositoryRoot: target.root,
        resolveHead: () => EXPECTED_SHA,
        runCommand: (command, args) => {
          commands.push([command, ...args].join(" "));
        },
      });

      expect(selected).toEqual(["sandbox-rebuild", "upgrade-stale-sandbox"]);
      expect(commands).toEqual([
        "npx vitest run --project cli src/lib/actions/sandbox/rebuild-flow-helpers.test.ts src/lib/actions/sandbox/rebuild-post-restore-phase.test.ts src/lib/actions/sandbox/rebuild-recreate-observability.test.ts src/lib/actions/sandbox/rebuild-route-preflight.test.ts src/lib/actions/upgrade-sandboxes-recovery.test.ts src/lib/sandbox/version.test.ts",
        "npx vitest run --project integration test/cli/list-share-live-inference.test.ts test/process-recovery/rebuild-stale-recovery.test.ts",
      ]);
      selected.forEach((id) => {
        const signalPath = path.join(target.artifactRoot, id, "risk-signal.json");
        expect(JSON.parse(fs.readFileSync(signalPath, "utf8"))).toMatchObject({
          jobId: id,
          expectedSha: EXPECTED_SHA,
          testedSha: EXPECTED_SHA,
          passed: 1,
          failed: 0,
        });
      });
    } finally {
      fs.rmSync(target.root, { force: true, recursive: true });
    }
  });

  it("fails before emitting passing evidence when a replacement command fails (#7616)", () => {
    const target = workspace();
    try {
      expect(() =>
        runRetiredSelectorCompatibility(
          environment(target, "cloud-onboard,gateway-health-honest"),
          {
            allowedJobs: ["cloud-onboard"],
            repositoryRoot: target.root,
            runCommand: () => {
              throw new Error("replacement failed");
            },
          },
        ),
      ).toThrow("replacement failed");
      expect(fs.readFileSync(target.output, "utf8")).toBe("selected=true\n");
      expect(fs.existsSync(target.artifactRoot)).toBe(false);
    } finally {
      fs.rmSync(target.root, { force: true, recursive: true });
    }
  });

  it("rejects compatibility while a selected live E2E file exists (#7616)", () => {
    const target = workspace();
    const legacyFile = path.join(target.root, "test/e2e/live/gateway-health-honest.test.ts");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, "export {};\n", "utf8");
    try {
      expect(() =>
        runRetiredSelectorCompatibility(
          environment(target, "cloud-onboard,gateway-health-honest"),
          {
            allowedJobs: ["cloud-onboard"],
            repositoryRoot: target.root,
            runCommand: () => undefined,
          },
        ),
      ).toThrow("requires its live E2E file to remain retired");
    } finally {
      fs.rmSync(target.root, { force: true, recursive: true });
    }
  });
});
