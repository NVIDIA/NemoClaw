// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { catalogueTarget } from "./target-inventory.mts";

export async function runCatalogueTarget(id: string, testFile: string): Promise<number> {
  const entry = catalogueTarget(id);
  if (entry.testFile !== testFile) {
    throw new Error(`E2E target ${id} does not own test file ${testFile}`);
  }
  Object.assign(process.env, entry.environment);
  if (entry.exposeCliBin) {
    process.env.NEMOCLAW_CLI_BIN = path.join(process.cwd(), "bin", "nemoclaw.js");
  }
  const runPressureCommand = (command: string): void => {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "tools/e2e/runner-pressure.mts", command],
      { env: process.env, stdio: "inherit", timeout: 60_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `runner pressure ${command} exited with status ${result.status ?? "unknown"}`,
      );
    }
  };
  if (entry.runnerPressure) {
    const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
    if (!artifactDirectory) throw new Error("runner pressure requires E2E_ARTIFACT_DIR");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    Object.assign(process.env, {
      DOCKER_OOM_CONTAINER: entry.environment.NEMOCLAW_SANDBOX_NAME,
      E2E_PHASE: `${entry.targetId}.workflow`,
      E2E_RESOURCE_BASELINE_FILE: path.join(artifactDirectory, "runner-pressure-baseline.jsonl"),
      E2E_RESOURCE_PHASE_BASELINES_FILE: path.join(
        artifactDirectory,
        "runner-pressure-phase-baselines.jsonl",
      ),
      E2E_TERMINAL_CLASSIFICATION_FILE: path.join(
        artifactDirectory,
        "runner-pressure-classification.jsonl",
      ),
      E2E_TEST_OUTCOME_FILE: path.join(artifactDirectory, "live-test-outcome.json"),
    });
    runPressureCommand("snapshot");
    runPressureCommand("initialize-evidence");
  }
  const { runLiveVitestCommand } = await import("./live-vitest-invocation.mts");
  process.env.NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST = "1";
  const selector = entry.selector ? ["--selector", entry.selector] : [];
  const exitCode = await runLiveVitestCommand(["run", "--test-path", entry.testFile, ...selector]);
  if (entry.runnerPressure && exitCode !== 0) {
    runPressureCommand("classify");
    runPressureCommand("validate-classification");
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, id, testFile] = process.argv.slice(2);
  if (command !== "run" || !id || !testFile) {
    throw new Error("Usage: target-catalogue.mts run <target-id> <test-file>");
  }
  void runCatalogueTarget(id, testFile).then((exitCode) => process.exit(exitCode));
}
