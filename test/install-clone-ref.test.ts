// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD } from "./helpers/installer-sourced-env";

const CURL_PIPE_INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

describe("installer git checkout", () => {
  it("fetches fully-qualified refs into a detached checkout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-ref-"));
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    const git = (args: string[], cwd = origin) => spawnSync("git", args, { cwd, encoding: "utf8" });

    try {
      expect(git(["init", "--initial-branch=topic"]).status).toBe(0);
      expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
      expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "fixture\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]).status).toBe(0);
      const expectedHead = git(["rev-parse", "HEAD"]).stdout.trim();

      for (const [index, installer] of [INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER].entries()) {
        const destination = path.join(tmp, `checkout-${index}`);
        const result = spawnSync(
          "bash",
          [
            "-c",
            'source "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref refs/heads/topic "$DESTINATION"',
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DESTINATION: destination,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
              INSTALLER_UNDER_TEST: installer,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(git(["-C", destination, "rev-parse", "HEAD"], tmp).stdout.trim()).toBe(expectedHead);
        expect(git(["-C", destination, "symbolic-ref", "-q", "HEAD"], tmp).status).not.toBe(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
