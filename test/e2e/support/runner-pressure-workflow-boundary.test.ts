// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  runCatalogueTarget,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";

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
        "NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST",
      ];
      for (const name of environmentNames) vi.stubEnv(name, process.env[name] ?? "");
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
        expect(process.env.NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST).toBe("1");
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
