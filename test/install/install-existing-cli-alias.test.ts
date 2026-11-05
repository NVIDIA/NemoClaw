// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
const createAlias = { symlink: fs.symlinkSync, hardlink: fs.linkSync };

it.skipIf(process.platform === "win32").each(["symlink", "hardlink"] as const)(
  "rejects an existing %s CLI alias in a writable shim directory (#12496)",
  (alias) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), `nemoclaw-install-unsafe-${alias}-`),
    );
    try {
      const fakeBin = path.join(root, "fake-bin");
      const npmPrefix = path.join(root, "prefix");
      const npmBin = path.join(npmPrefix, "bin");
      const packagedCli = path.join(npmBin, "nemoclaw-acp");
      const shimDir = path.join(root, ".local", "bin");
      const shimPath = path.join(shimDir, "nemoclaw-acp");
      fs.mkdirSync(fakeBin);
      fs.mkdirSync(npmBin, { recursive: true });
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(
        path.join(fakeBin, "node"),
        `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "npm"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$ACTIVE_NPM_PREFIX"\n',
        { mode: 0o755 },
      );
      const originalContents = '#!/usr/bin/env bash\necho "nemoclaw-acp v0.1.0"\n';
      fs.writeFileSync(packagedCli, originalContents, { mode: 0o755 });
      fs.chmodSync(shimDir, 0o775);
      createAlias[alias](packagedCli, shimPath);

      const result = spawnSync(
        "bash",
        ["-c", 'source "$1" >/dev/null 2>&1; ensure_cli_shim nemoclaw-acp', "bash", INSTALLER],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ACTIVE_NPM_PREFIX: npmPrefix,
            HOME: root,
            NO_COLOR: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status, `${alias}: ${result.stdout}${result.stderr}`).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(shimDir);
      expect(fs.readFileSync(packagedCli, "utf8")).toBe(originalContents);
      expect(fs.statSync(shimDir).mode & 0o777).toBe(0o775);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a CLI directory alias through a writable intermediate link (#10947)",
  () => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nemoclaw-install-unsafe-hop-"),
    );
    try {
      const fakeBin = path.join(root, "fake-bin");
      const npmPrefix = path.join(root, "prefix");
      const npmBin = path.join(npmPrefix, "bin");
      const packagedCli = path.join(npmBin, "nemoclaw-acp");
      const shimDir = path.join(root, ".local", "bin");
      const writableDir = path.join(root, "writable-hop");
      fs.mkdirSync(fakeBin);
      fs.mkdirSync(npmBin, { recursive: true });
      fs.mkdirSync(path.dirname(shimDir), { recursive: true });
      fs.mkdirSync(writableDir);
      fs.chmodSync(writableDir, 0o777);
      fs.writeFileSync(
        path.join(fakeBin, "node"),
        `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "npm"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$ACTIVE_NPM_PREFIX"\n',
        { mode: 0o755 },
      );
      const originalContents = '#!/usr/bin/env bash\necho "nemoclaw-acp v0.1.0"\n';
      fs.writeFileSync(packagedCli, originalContents, { mode: 0o755 });
      const intermediateLink = path.join(writableDir, "npm-bin");
      fs.symlinkSync(npmBin, intermediateLink, "dir");
      fs.symlinkSync(intermediateLink, shimDir, "dir");
      expect(fs.realpathSync(shimDir)).toBe(fs.realpathSync(npmBin));

      const result = spawnSync(
        "bash",
        ["-c", 'source "$1" >/dev/null 2>&1; ensure_cli_shim nemoclaw-acp', "bash", INSTALLER],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ACTIVE_NPM_PREFIX: npmPrefix,
            HOME: root,
            NO_COLOR: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
        },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Unsafe user-local executable directory",
      );
      expect(fs.readFileSync(packagedCli, "utf8")).toBe(originalContents);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
