// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLinuxArm64DownloadFixture } from "../support/openshell-arm64-download";
import { writeExecutable } from "../support/openshell-installed-version";

const SCRIPT = path.join(import.meta.dirname, "../..", "scripts", "install-openshell.sh");

describe("OpenShell installer directory safety", { timeout: 15_000 }, () => {
  it("creates owner-safe user-local directories in a direct install under umask 0002 (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const bashEnv = path.join(tmp, "force-user-local-install.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then
    return 1
  fi
  builtin [ "$@"
}
`,
      );
      const previousUmask = process.umask(0o002);
      let directInstall;
      try {
        directInstall = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            BASH_ENV: bashEnv,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_TEST_USER_LOCAL_ONLY: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });
      } finally {
        process.umask(previousUmask);
      }
      expect(directInstall.status, `${directInstall.stdout}\n${directInstall.stderr}`).toBe(0);
      expect({
        local: fs.statSync(path.join(tmp, ".local")).mode & 0o777,
        bin: fs.statSync(path.join(tmp, ".local", "bin")).mode & 0o777,
      }).toEqual({ local: 0o755, bin: 0o755 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("falls back from a writable unsafe system default in interactive mode (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const localBin = path.join(tmp, ".local", "bin");
      const bashEnv = path.join(tmp, "unsafe-system-target.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then return 0; fi
  if [[ "$#" -eq 4 && "$1" = "!" && "$2" = "-t" && "$3" = "0" && "$4" = "]" ]]; then return 1; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" /usr/local/bin "* ]]; then printf "0 775\\n"; return 0; fi
  command stat "$@"
}
`,
      );
      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          XDG_BIN_HOME: "",
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(localBin, "openshell"))).toBe(true);
      expect(fs.existsSync(path.join(localBin, "openshell-gateway"))).toBe(true);
      expect(fs.statSync(localBin).mode & 0o777).toBe(0o755);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects an unsafe system directory before invoking sudo (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const sudoLog = path.join(tmp, "sudo.log");
      writeExecutable(
        path.join(fakeBin, "sudo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NEMOCLAW_TEST_SUDO_LOG"\nexit 99\n',
      );
      const bashEnv = path.join(tmp, "unsafe-privileged-system-target.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then return 1; fi
  if [[ "$#" -eq 4 && "$1" = "!" && "$2" = "-t" && "$3" = "0" && "$4" = "]" ]]; then return 1; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" /usr/local/bin "* ]]; then printf "0 775\\n"; return 0; fi
  command stat "$@"
}
`,
      );
      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          NEMOCLAW_TEST_SUDO_LOG: sudoLog,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Unsafe executable directory /usr/local/bin");
      expect(fs.existsSync(sudoLog)).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".local", "bin", "openshell"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it.each(["writable ancestor", "symlinked bin"])(
    "rejects a %s before publishing a direct user-local binary (#12496)",
    (unsafePath) => {
      const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
      try {
        fs.rmSync(path.join(fakeBin, "openshell"));
        const local = path.join(tmp, ".local");
        const bin = path.join(local, "bin");
        const outside = path.join(tmp, "outside");
        fs.mkdirSync(local);
        const makeUnsafe: Record<string, () => void> = {
          "writable ancestor": () => {
            fs.mkdirSync(bin);
            fs.chmodSync(local, 0o775);
          },
          "symlinked bin": () => {
            fs.mkdirSync(outside);
            fs.symlinkSync(outside, bin);
          },
        };
        makeUnsafe[unsafePath]();
        const bashEnv = path.join(tmp, "force-user-local-install.sh");
        fs.writeFileSync(
          bashEnv,
          `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then
    return 1
  fi
  builtin [ "$@"
}
`,
        );
        const result = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            BASH_ENV: bashEnv,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_TEST_USER_LOCAL_ONLY: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(unsafePath === "writable ancestor" ? local : bin);
        expect(
          fs.existsSync(path.join(unsafePath === "writable ancestor" ? bin : outside, "openshell")),
        ).toBe(false);
        const assertUnchanged: Record<string, () => void> = {
          "writable ancestor": () => expect(fs.statSync(local).mode & 0o777).toBe(0o775),
          "symlinked bin": () => expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true),
        };
        assertUnchanged[unsafePath]();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
