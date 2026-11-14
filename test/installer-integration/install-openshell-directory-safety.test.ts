// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLinuxArm64DownloadFixture } from "../support/openshell-arm64-download";
import { writeExecutable } from "../support/openshell-installed-version";

import credentialBoundaryManifest from "../../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.1.7.json";

const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;
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
  it.each(["", "1"])(
    "replaces an unsafe existing destination through the private directory with noninteractive=%s (#14268)",
    (nonInteractive) => {
      const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
      try {
        const oldBinary = fs.readFileSync(path.join(fakeBin, "openshell"));
        fs.chmodSync(fakeBin, 0o775);
        const privateBin = path.join(tmp, ".local", "bin");
        const result = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: nonInteractive,
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fs.readFileSync(path.join(fakeBin, "openshell"))).toEqual(oldBinary);
        expect(fs.statSync(fakeBin).mode & 0o777).toBe(0o775);
        const installedVersion = spawnSync(path.join(privateBin, "openshell"), ["--version"], {
          encoding: "utf8",
        });
        expect(installedVersion.status).toBe(0);
        expect(installedVersion.stdout).toContain(`openshell ${REQUIRED_OPENSHELL_VERSION}`);
        expect(fs.existsSync(path.join(privateBin, "openshell-gateway"))).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("replaces the safe nonwritable active system binary in interactive mode (#14268)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    const systemBin = path.join(tmp, "system-bin");
    fs.mkdirSync(systemBin);
    try {
      fs.renameSync(path.join(fakeBin, "openshell"), path.join(systemBin, "openshell"));
      const sudoLog = path.join(tmp, "sudo.log");
      writeExecutable(
        path.join(fakeBin, "sudo"),
        `#!/usr/bin/env bash
[[ "$1" = install && "\${@: -1}" == "$HOME/system-bin/"* ]] || exit 97
printf '%s\\n' "$*" >> "$HOME/sudo.log"
chmod u+w "$HOME/system-bin"
"$@"
status=$?
chmod 555 "$HOME/system-bin"
exit "$status"
`,
      );
      const bashEnv = path.join(tmp, "interactive-safe-system.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" = 3 && "$1" = -t && "$2" = 0 ]]; then return 0; fi
  if [[ "$#" = 4 && "$1" = '!' && "$2" = -t && "$3" = 0 ]]; then return 1; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" $HOME/system-bin "* ]]; then printf '0 755\\n'; return 0; fi
  command stat "$@"
}
`,
      );
      fs.chmodSync(systemBin, 0o555);
      // Confine the system destination to the fixture before executing the real installer.
      const installer = path.join(tmp, "install-openshell.sh");
      fs.writeFileSync(
        installer,
        fs.readFileSync(SCRIPT, "utf8").replaceAll("/usr/local/bin", systemBin),
      );
      const result = spawnSync("bash", [installer], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          XDG_BIN_HOME: "",
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${systemBin}:${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const active = spawnSync(path.join(systemBin, "openshell"), ["--version"], {
        encoding: "utf8",
      });
      expect(active.status).toBe(0);
      expect(active.stdout.trim()).toBe(`openshell ${REQUIRED_OPENSHELL_VERSION}`);
      expect(fs.readFileSync(sudoLog, "utf8")).toContain(` ${path.join(systemBin, "openshell")}`);
      expect(fs.existsSync(path.join(tmp, ".local", "bin", "openshell"))).toBe(false);
    } finally {
      fs.chmodSync(systemBin, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("selects the prepared replacement when its directory already occurs later on PATH (#14268)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      const privateBin = path.join(tmp, ".local", "bin");
      fs.mkdirSync(privateBin, { recursive: true });
      fs.chmodSync(fakeBin, 0o775);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
source "$1/scripts/install.sh" >/dev/null 2>&1
NEMOCLAW_SOURCE_ROOT="$1"
_NEMOCLAW_PREPARED_OPENSHELL_INSTALL_DIR="$2"
spin() { shift; "$@"; }
install_nemoclaw_openshell_gateway_user_service() { :; }
maybe_install_openshell_during_install force
[ "$(command -v openshell)" = "$2/openshell" ]
[ "$NEMOCLAW_OPENSHELL_BIN" = "$2/openshell" ]
[ "$(resolve_openshell_gateway_bin_for_service)" = "$2/openshell-gateway" ]
`,
          "test",
          path.resolve(import.meta.dirname, "../.."),
          privateBin,
        ],
        {
          env: {
            ...process.env,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            PATH: `${fakeBin}:${privateBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechecks the prepared directory through the installer caller before replacement (#14268)", () => {
    const { tmp, fakeBin, downloadLog } = createLinuxArm64DownloadFixture();
    try {
      const env = {
        ...process.env,
        HOME: tmp,
        XDG_BIN_HOME: "",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        PATH: `${fakeBin}:/usr/bin:/bin`,
      };
      const preparation = spawnSync("bash", [SCRIPT, "--prepare-install-directory"], {
        env,
        encoding: "utf8",
      });
      expect(preparation.status, preparation.stdout + preparation.stderr).toBe(0);
      expect(preparation.stdout.trim()).toBe(fakeBin);
      expect(fs.existsSync(downloadLog)).toBe(false);
      const oldBinary = fs.readFileSync(path.join(fakeBin, "openshell"));
      fs.chmodSync(fakeBin, 0o775);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
source "$1/scripts/install.sh" >/dev/null 2>&1
NEMOCLAW_SOURCE_ROOT="$1"
_NEMOCLAW_PREPARED_OPENSHELL_INSTALL_DIR="$2"
spin() { shift; "$@"; }
install_nemoclaw_openshell_gateway_user_service() { :; }
maybe_install_openshell_during_install force
`,
          "test",
          path.resolve(import.meta.dirname, "../.."),
          preparation.stdout.trim(),
        ],
        { env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unsafe prepared executable directory");
      expect(fs.readFileSync(path.join(fakeBin, "openshell"))).toEqual(oldBinary);
      expect(fs.existsSync(path.join(tmp, ".local", "bin"))).toBe(false);
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
  if [[ "$#" -eq 3 && "$1" = "-t" && "$2" = "0" && "$3" = "]" ]]; then return 0; fi
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
