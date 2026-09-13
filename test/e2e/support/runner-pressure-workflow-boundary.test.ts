// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCatalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runLiveVitestCommand: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../../../tools/e2e/live-vitest-invocation.mts", () => ({
  runLiveVitestCommand: mocks.runLiveVitestCommand,
}));

import {
  catalogueTarget,
  E2E_TARGET_CATALOGUE,
  listTargets,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-inventory.mts";

describe("typed target execution through the standard profile", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects a known catalogue target paired with another target's test", async () => {
    await expect(
      runCatalogueTarget("rebuild-hermes", "test/e2e/live/full-e2e.test.ts"),
    ).rejects.toThrow("does not own test file");
    expect(mocks.runLiveVitestCommand).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it.each(listTargets().map(({ id }) => id))(
    "selects only %s and returns the live test failure",
    async (id) => {
      vi.stubEnv("TARGET_ID", undefined);
      vi.stubEnv("E2E_TARGET_ID", undefined);
      vi.stubEnv("NEMOCLAW_CLI_BIN", undefined);
      vi.stubEnv("NEMOCLAW_E2E_USE_HOSTED_INFERENCE", undefined);
      mocks.runLiveVitestCommand.mockImplementation(async () => {
        expect(process.env).toMatchObject({
          TARGET_ID: id,
          E2E_TARGET_ID: id,
          NEMOCLAW_CLI_BIN: path.join(process.cwd(), "bin", "nemoclaw.js"),
          NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        });
        return 17;
      });
      await expect(runCatalogueTarget(id, "test/e2e/live/registry-targets.test.ts")).resolves.toBe(
        17,
      );
      expect(mocks.runLiveVitestCommand).toHaveBeenCalledWith([
        "run",
        "--test-path",
        "test/e2e/live/registry-targets.test.ts",
        "--selector",
        `^${id}:`,
      ]);
      expect(mocks.spawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", "test/e2e/live/registry-targets.test.ts"],
    ["unknown-target", "test/e2e/live/registry-targets.test.ts"],
    ["rebuild-hermes", "test/e2e/live/registry-targets.test.ts"],
    ["ubuntu-repo-cloud-openclaw", "test/e2e/live/rebuild-hermes.test.ts"],
  ])("rejects target %s with an invalid execution route", async (id, file) => {
    vi.stubEnv("TARGET_ID", "unchanged");
    await expect(runCatalogueTarget(id, file)).rejects.toThrow();
    expect(process.env.TARGET_ID).toBe("unchanged");
    expect(mocks.runLiveVitestCommand).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});

describe("runner-pressure catalogue boundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["rebuild-hermes", "rebuild-hermes-stale-base"])(
    "keeps %s on the shared rebuild lifecycle",
    (id) => {
      expect(() => validateE2eTargetCatalogue(E2E_TARGET_CATALOGUE)).not.toThrow();
      expect(catalogueTarget(id)).toMatchObject({
        testFile: "test/e2e/live/rebuild-hermes.test.ts",
        profile: "nvidia-inference",
        hostPreparation: "rebuild-swap",
        runnerComparison: true,
        runnerPressure: true,
        owningPaths: expect.arrayContaining(["test/e2e/live/rebuild-hermes-cron-restore.ts"]),
      });
    },
  );

  it.each([
    { exitCode: 17, finalCommands: ["classify", "validate-classification"] },
    { exitCode: 0, finalCommands: [] },
  ])(
    "classifies only failed rebuilds before returning status $exitCode",
    async ({ exitCode, finalCommands }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-runner-pressure-"));
      const target = catalogueTarget("rebuild-hermes");
      const environmentNames = [
        ...Object.keys(target.environment),
        "DOCKER_OOM_CONTAINER",
        "E2E_ARTIFACT_DIR",
        "E2E_PHASE",
        "E2E_RESOURCE_BASELINE_FILE",
        "E2E_RESOURCE_PHASE_BASELINES_FILE",
        "E2E_TERMINAL_CLASSIFICATION_FILE",
        "E2E_TEST_OUTCOME_FILE",
        "NEMOCLAW_CLI_BIN",
      ];
      environmentNames.forEach((name) => {
        vi.stubEnv(name, process.env[name] ?? "");
      });
      vi.stubEnv("E2E_ARTIFACT_DIR", directory);
      mocks.spawnSync.mockReturnValue({ status: 0 });
      mocks.runLiveVitestCommand.mockResolvedValue(exitCode);

      try {
        await expect(runCatalogueTarget(target.id, target.testFile)).resolves.toBe(exitCode);
        expect(mocks.runLiveVitestCommand).toHaveBeenCalledWith([
          "run",
          "--test-path",
          target.testFile,
        ]);
        expect(mocks.spawnSync.mock.calls.map((call) => call[1].at(-1))).toEqual([
          "snapshot",
          "initialize-evidence",
          ...finalCommands,
        ]);
      } finally {
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
