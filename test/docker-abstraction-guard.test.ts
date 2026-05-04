// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const INVENTORY_SCRIPT = path.join(REPO_ROOT, "scripts", "list-command-helper-uses.ts");
const DOCKER_ABSTRACTION_PREFIX = "src/lib/docker/";

type CommandUse = {
  filePath: string;
  line: number;
  column: number;
  kind: "call" | "assign";
  name: string;
  expression: string;
  commandHead: string | null;
  snippet: string;
};

function listCommandUses(): CommandUse[] {
  const result = spawnSync(
    TSX,
    [INVENTORY_SCRIPT, "--json", "--list-calls", "src"],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as CommandUse[];
}

describe("Docker command abstraction guard", () => {
  it("keeps direct docker process launches inside src/lib/docker", () => {
    const directDockerCalls = listCommandUses().filter(
      (entry) =>
        entry.kind === "call" &&
        entry.commandHead === "docker" &&
        !entry.filePath.startsWith(DOCKER_ABSTRACTION_PREFIX),
    );

    if (directDockerCalls.length > 0) {
      const formatted = directDockerCalls
        .map(
          (entry) =>
            `  - ${entry.filePath}:${String(entry.line)}:${String(entry.column)} ${entry.expression}: ${entry.snippet}`,
        )
        .join("\n");
      throw new Error(
        `Direct docker process launches must use the src/lib/docker abstractions.\n` +
          `Do not add calls like run(["docker", ...]), runCapture(["docker", ...]), ` +
          `spawnSync("docker", ...), or execFileSync("docker", ...) outside ${DOCKER_ABSTRACTION_PREFIX}.\n` +
          `Add or reuse a helper under ${DOCKER_ABSTRACTION_PREFIX} (for example dockerRun(), dockerCapture(), dockerPull(), dockerRmi(), dockerExecFileSync(), or dockerSpawnSync()) and call that instead.\n` +
          `Violations:\n${formatted}`,
      );
    }

    expect(directDockerCalls).toEqual([]);
  });
});
