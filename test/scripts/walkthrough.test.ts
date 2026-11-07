// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WALKTHROUGH_SCRIPT = path.join(REPO_ROOT, "scripts", "walkthrough.sh");

describe("walkthrough.sh", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-walkthrough-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("launches the agent pane with sandbox exec instead of passing a child command to connect", () => {
    const bin = path.join(root, "bin");
    const log = path.join(root, "tmux.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "tmux"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`,
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [WALKTHROUGH_SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NVIDIA_INFERENCE_API_KEY: "nvapi-test",
      },
    });

    expect(result.status).toBe(0);
    const splitWindow = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .find((line) => line.startsWith("split-window"));
    expect(splitWindow).toContain(
      "openshell sandbox exec --name nemoclaw --tty -- bash -c 'nemoclaw-start openclaw agent --agent main --local --session-id live'",
    );
    expect(splitWindow).not.toMatch(/sandbox connect \S+ --/);
  });
});
