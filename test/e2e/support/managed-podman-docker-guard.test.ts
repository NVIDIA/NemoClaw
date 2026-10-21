// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { buildDockerSubprocessEnv } from "../../../src/lib/subprocess-env";

it("records forbidden Docker calls after the CLI filters the guard environment", () => {
  const workflow = YAML.parse(
    fs.readFileSync(
      new URL("../../../.github/workflows/managed-images.yaml", import.meta.url),
      "utf8",
    ),
  ) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find(({ run }) => run?.includes("<<'DOCKER_GUARD'"));
  const script = step?.run?.split("<<'DOCKER_GUARD'\n")[1]?.split("\nDOCKER_GUARD")[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-guard-"));
  try {
    fs.mkdirSync(path.join(root, "bin"));
    const executable = path.join(root, "bin", "docker");
    const log = path.join(root, "invocations.log");
    fs.writeFileSync(executable, script!, { mode: 0o700 });
    fs.writeFileSync(log, "");
    const env = buildDockerSubprocessEnv(
      { PATH: process.env.PATH, E2E_DOCKER_GUARD_LOG: log },
      undefined,
    );
    const result = spawnSync(executable, ["stop", "private-container-argument"], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(97);
    expect(fs.readFileSync(log, "utf8")).toBe("stop\n");
    expect(result.stderr).not.toContain("private-container-argument");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
