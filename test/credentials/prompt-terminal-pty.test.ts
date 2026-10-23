// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "../helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DRIVER = path.join(import.meta.dirname, "..", "fixtures", "credential-prompt-pty-driver.ts");

const ptySupported =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

describe.runIf(ptySupported)("credential prompts under a pseudo-TTY", () => {
  it(
    "cancels on Ctrl-D between prompts and restores the terminal (#12169)",
    testTimeoutOptions(30_000),
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-prompt-pty-"));
      const statePath = path.join(root, "onboard-session.json");
      const capturedStderr = path.join(root, "captured-stderr.log");
      const command = `${JSON.stringify(TSX)} ${JSON.stringify(DRIVER)} 2>${JSON.stringify(capturedStderr)}`;
      const child = spawn("script", ["-qec", command, "/dev/null"], {
        cwd: REPO_ROOT,
        env: { ...process.env, NEMOCLAW_PROMPT_PTY_STATE: statePath },
        stdio: ["pipe", "pipe", "inherit"],
      });
      child.stdin.on("error", () => {});

      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

      try {
        const firstPromptDeadline = Date.now() + execTimeout(15_000);
        while (
          (!fs.existsSync(capturedStderr) ||
            !fs.readFileSync(capturedStderr, "utf8").includes("first: ")) &&
          Date.now() < firstPromptDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(fs.readFileSync(capturedStderr, "utf8")).toContain("first: ");

        child.stdin.write("alpha\n");
        const deadline = Date.now() + execTimeout(15_000);
        while (!output.includes("BETWEEN_PROMPTS") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(output).toContain("BETWEEN_PROMPTS");

        child.stdin.write("\u0004");

        await expect(exited).resolves.toBe(42);
        expect(output).toContain("CANCEL_CODE=EOF");
        expect(output).toContain("TTY_RAW=false");
        expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
          status: "in_progress",
          resumable: true,
        });
        expect(fs.readFileSync(capturedStderr, "utf8")).toContain("second: ");
      } finally {
        child.exitCode === null && child.kill("SIGKILL");
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
