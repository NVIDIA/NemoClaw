// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

describe("packaged Hermes ACP adapter", () => {
  it("installs one executable backed by the compiled host adapter (#10947)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-package-"));
    const consumerRoot = path.join(fixtureRoot, "consumer");
    fs.mkdirSync(consumerRoot);
    fs.writeFileSync(
      path.join(consumerRoot, "package.json"),
      JSON.stringify({ name: "nemoclaw-acp-package-consumer", private: true }),
    );
    const env = {
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      NEMOCLAW_INSTALLING: "1",
      PATH: process.env.PATH,
    };
    try {
      const install = spawnSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--offline",
          "--omit=dev",
          "--no-save",
          "--package-lock=false",
          REPOSITORY_ROOT,
        ],
        {
          cwd: consumerRoot,
          encoding: "utf8",
          env,
          timeout: 120_000,
        },
      );
      expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);

      const executable = path.join(consumerRoot, "node_modules", ".bin", "nemoclaw-acp");
      const help = spawnSync(executable, ["--help"], {
        cwd: consumerRoot,
        encoding: "utf8",
        env,
        timeout: 30_000,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage: nemoclaw-acp --sandbox <name>");
      expect(help.stderr).toBe("");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
