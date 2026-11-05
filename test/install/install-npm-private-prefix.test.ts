// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

it.skipIf(process.platform === "win32").each(["group-writable", "symlink"])(
  "links through a private npm prefix instead of an unsafe %s source prefix (#12496)",
  (kind) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nemoclaw-private-npm-prefix-"),
    );
    try {
      const home = path.join(root, "home");
      const source = path.join(root, "source");
      const unsafePrefix = path.join(root, "shared-prefix");
      const sharedTarget = path.join(root, "shared-target");
      const privatePrefix = path.join(home, ".npm-global");
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(source);
      fs.mkdirSync(sharedTarget);
      fs.chmodSync(sharedTarget, 0o775);
      kind === "symlink" ? fs.symlinkSync(sharedTarget, unsafePrefix) : fs.mkdirSync(unsafePrefix);
      fs.chmodSync(unsafePrefix, 0o775);
      fs.writeFileSync(path.join(source, ".npmrc"), `prefix=${unsafePrefix}\n`);
      fs.writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          name: "nemoclaw-prefix-fixture",
          version: "1.0.0",
          bin: { "prefix-fixture": "cli.js" },
        }),
      );
      fs.writeFileSync(path.join(source, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
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

      const fallback = spawnSync(
        "bash",
        [
          "-c",
          'source "$1" >/dev/null 2>&1; uname() { printf "Linux\\n"; }; umask 0002; fix_npm_permissions; link_nemoclaw_cli "$2"; cd "$2"; npm config get prefix',
          "bash",
          INSTALLER,
          source,
        ],
        {
          cwd: root,
          env: {
            ...env,
            NPM_CONFIG_PREFIX: unsafePrefix,
            npm_config_prefix: unsafePrefix,
            NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
            npm_config_userconfig: path.join(home, ".npmrc"),
            npm_config_offline: "true",
            npm_config_audit: "false",
            npm_config_fund: "false",
          },
          encoding: "utf8",
        },
      );
      expect(fallback.status, `${fallback.stdout}${fallback.stderr}`).toBe(0);
      expect(fallback.stdout.trim().split("\n").at(-1)).toBe(privatePrefix);
      expect(fs.statSync(unsafePrefix).mode & 0o777).toBe(0o775);
      expect(fs.statSync(privatePrefix).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(unsafePrefix, "lib"))).toBe(false);
      expect(fs.statSync(path.join(privatePrefix, "bin")).mode & 0o022).toBe(0);
      expect(fs.statSync(path.join(privatePrefix, "lib")).mode & 0o022).toBe(0);
      expect(fs.statSync(path.join(privatePrefix, "lib/node_modules")).mode & 0o022).toBe(0);
      expect(fs.realpathSync(path.join(privatePrefix, "bin", "prefix-fixture"))).toBe(
        path.join(source, "cli.js"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
