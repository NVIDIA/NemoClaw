// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

it.skipIf(process.platform === "win32")(
  "honors a private npm prefix over an unsafe source prefix (#12496)",
  () => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nemoclaw-private-npm-prefix-"),
    );
    try {
      const home = path.join(root, "home");
      const source = path.join(root, "source");
      const unsafePrefix = path.join(root, "shared-prefix");
      const privatePrefix = path.join(home, ".npm-global");
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(source);
      fs.mkdirSync(unsafePrefix);
      fs.chmodSync(unsafePrefix, 0o775);
      fs.writeFileSync(path.join(source, ".npmrc"), `prefix=${unsafePrefix}\n`);
      const env = { ...process.env, HOME: home, NPM_CONFIG_PREFIX: privatePrefix };

      const configured = spawnSync("npm", ["config", "get", "prefix"], {
        cwd: source,
        env,
        encoding: "utf8",
      });
      expect(configured.status, configured.stderr).toBe(0);
      expect(configured.stdout.trim()).toBe(privatePrefix);

      const safe = spawnSync(
        "bash",
        [
          "-c",
          'source "$1" >/dev/null 2>&1; assert_npm_executable_prefix_safe "$2"',
          "bash",
          INSTALLER,
          privatePrefix,
        ],
        { cwd: source, env, encoding: "utf8" },
      );
      expect(safe.status, `${safe.stdout}${safe.stderr}`).toBe(0);
      expect(fs.existsSync(privatePrefix)).toBe(false);

      fs.mkdirSync(privatePrefix, { mode: 0o700 });
      const existingPrivate = spawnSync(
        "bash",
        [
          "-c",
          'source "$1" >/dev/null 2>&1; assert_npm_executable_prefix_safe "$2"',
          "bash",
          INSTALLER,
          privatePrefix,
        ],
        { cwd: source, env, encoding: "utf8" },
      );
      expect(existingPrivate.status, `${existingPrivate.stdout}${existingPrivate.stderr}`).toBe(0);
      expect(fs.statSync(privatePrefix).mode & 0o777).toBe(0o700);

      const unsafe = spawnSync(
        "bash",
        [
          "-c",
          'source "$1" >/dev/null 2>&1; assert_npm_executable_prefix_safe "$2"',
          "bash",
          INSTALLER,
          unsafePrefix,
        ],
        { cwd: source, env, encoding: "utf8" },
      );
      expect(unsafe.status).toBe(1);
      expect(unsafe.stderr).toContain(unsafePrefix);
      expect(fs.statSync(unsafePrefix).mode & 0o777).toBe(0o775);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
