// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; run?: string };

function actionSetupScript(): string {
  const action = YAML.parse(
    fs.readFileSync(".github/actions/setup-native-podman-e2e/action.yaml", "utf8"),
  ) as { runs: { steps: Step[] } };
  return action.runs.steps.find((step) => step.name === "Start native Podman runtime")?.run ?? "";
}

function headroomGuard(): string {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const run = workflow.jobs["portable-hermes-finalization"]?.steps.find(
    (step) => step.name === "Set Portable Podman registry process headroom",
  )?.run;
  return (
    run?.split("\n").find((line) => line.trimStart().startsWith('[[ "$service_unit" ==')) ??
    "exit 2"
  );
}

describe("native Podman service unit guard", () => {
  it("accepts the pinned action's unit and rejects an unrelated file or symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-service-unit-"));
    const env = {
      ...process.env,
      HOME: path.join(root, "home"),
      RUNNER_TEMP: path.join(root, "runner-temp"),
    };
    try {
      const setupLines = actionSetupScript().split("\n");
      const assignments = ["service_name", "service_unit_directory", "service_unit"].map(
        (name) => setupLines.find((line) => line.trimStart().startsWith(`${name}=`))?.trim() ?? "",
      );
      const located = spawnSync(
        "/bin/bash",
        ["-c", `set -eu\n${assignments.join("\n")}\nprintf '%s' "$service_unit"`],
        { encoding: "utf8", env },
      );
      expect(located.status).toBe(0);
      const unit = located.stdout;
      const guard = headroomGuard();
      const evaluate = (serviceUnit: string) =>
        spawnSync("/bin/bash", ["-c", guard], {
          env: { ...env, service: path.basename(unit), service_unit: serviceUnit },
        }).status;

      fs.mkdirSync(path.dirname(unit), { recursive: true });
      fs.mkdirSync(env.RUNNER_TEMP);
      fs.writeFileSync(unit, "[Service]\n");
      const other = path.join(env.RUNNER_TEMP, path.basename(unit));
      fs.writeFileSync(other, "[Service]\n");
      expect(evaluate(unit)).toBe(0);
      expect(evaluate(other)).not.toBe(0);
      fs.rmSync(unit);
      fs.symlinkSync(other, unit);
      expect(evaluate(unit)).not.toBe(0);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
