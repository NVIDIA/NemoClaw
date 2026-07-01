// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { buildRawTokenProcessProbe } from "../live/messaging-providers-helpers.ts";

describe("messaging provider process token probe", () => {
  it("matches by digest without exposing a reversible token value in child argv", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-probe-"));
    const procRoot = path.join(root, "proc");
    const wrapperPath = path.join(root, "node-wrapper");
    const argvLog = path.join(root, "argv.log");
    const token = "raw-messaging-token-[literal]*?";
    const matchingCmdline = path.join(procRoot, "101", "cmdline");
    const otherCmdline = path.join(procRoot, "202", "cmdline");

    try {
      fs.mkdirSync(path.dirname(matchingCmdline), { recursive: true });
      fs.mkdirSync(path.dirname(otherCmdline), { recursive: true });
      fs.mkdirSync(path.join(procRoot, "303"), { recursive: true });
      fs.symlinkSync(path.join(root, "vanished-cmdline"), path.join(procRoot, "303", "cmdline"));
      fs.writeFileSync(matchingCmdline, Buffer.from(`node\0--credential=${token}\0`, "utf8"));
      fs.writeFileSync(otherCmdline, Buffer.from("sleep\0infinity\0", "utf8"));
      fs.writeFileSync(
        wrapperPath,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" >> "$NEMOCLAW_ARGV_LOG"',
          `exec ${JSON.stringify(process.execPath)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      const script = buildRawTokenProcessProbe(token, procRoot, wrapperPath);
      expect(script).not.toContain(token);
      expect(script).not.toContain(Buffer.from(token, "utf8").toString("base64"));
      expect(script).not.toContain(Buffer.from(token, "utf8").toString("hex"));

      const found = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: { NEMOCLAW_ARGV_LOG: argvLog },
      });
      expect(found.status, found.stderr).toBe(0);
      expect(found.stdout).toBe("FOUND\n");
      const foundArgv = fs.readFileSync(argvLog, "utf8");
      expect(foundArgv).not.toContain(token);
      expect(foundArgv).not.toContain(Buffer.from(token, "utf8").toString("base64"));
      expect(foundArgv).not.toContain(Buffer.from(token, "utf8").toString("hex"));

      fs.writeFileSync(matchingCmdline, Buffer.from("node\0--credential=other\0", "utf8"));
      fs.writeFileSync(argvLog, "");
      const absent = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: { NEMOCLAW_ARGV_LOG: argvLog },
      });
      expect(absent.status, absent.stderr).toBe(0);
      expect(absent.stdout).toBe("ABSENT\n");
      expect(fs.readFileSync(argvLog, "utf8")).not.toContain(token);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
