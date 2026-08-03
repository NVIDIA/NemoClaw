// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "setup-jetson.sh");

const HOST_MUTATION_COMMANDS = [
  "sudo",
  "chmod",
  "modprobe",
  "stat",
  "sysctl",
  "tee",
  "udevadm",
  "update-alternatives",
  "systemctl",
  "python3",
];

type SetupJetsonRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  headArgs: string;
  commandLog: string;
};

function withJetsonReleaseSandbox<T>(
  run: (paths: {
    commandLogPath: string;
    headArgsPath: string;
    releasePath: string;
    statCountPath: string;
    stubDir: string;
  }) => T,
): T {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-release-"));

  try {
    const stubDir = path.join(tempDir, "bin");
    const commandLogPath = path.join(tempDir, "command-log");
    const headArgsPath = path.join(tempDir, "head-args");
    const releasePath = path.join(tempDir, "nv_tegra_release");
    const statCountPath = path.join(tempDir, "stat-count");
    mkdirSync(stubDir);
    writeFileSync(commandLogPath, "");
    for (const command of HOST_MUTATION_COMMANDS) {
      const stubPath = path.join(stubDir, command);
      writeFileSync(
        stubPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `printf '%s %s\\n' ${JSON.stringify(command)} "$*" >> ${JSON.stringify(commandLogPath)}`,
          `if [[ ${JSON.stringify(command)} == "tee" || ( ${JSON.stringify(command)} == "sudo" && "\${1:-}" == "tee" ) ]]; then`,
          "  input=",
          "  IFS= read -r input || true",
          `  printf 'stdin %s\\n' "$input" >> ${JSON.stringify(commandLogPath)}`,
          "fi",
          `if [[ ${JSON.stringify(command)} == "stat" ]]; then`,
          `  if [[ -f ${JSON.stringify(statCountPath)} ]]; then`,
          '    output="${NEMOCLAW_TEST_STAT_OUTPUT_AFTER:-${NEMOCLAW_TEST_STAT_OUTPUT:-}}"',
          "  else",
          `    : > ${JSON.stringify(statCountPath)}`,
          '    output="${NEMOCLAW_TEST_STAT_OUTPUT:-}"',
          "  fi",
          '  [[ -n "$output" ]] || exit "${NEMOCLAW_TEST_STAT_STATUS:-1}"',
          "  printf '%s\\n' \"$output\"",
          '  exit "${NEMOCLAW_TEST_STAT_STATUS:-0}"',
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(stubPath, 0o755);
    }

    const headStubPath = path.join(stubDir, "head");
    writeFileSync(
      headStubPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" > ${JSON.stringify(headArgsPath)}`,
        `if [[ -f ${JSON.stringify(releasePath)} ]]; then`,
        `  cat ${JSON.stringify(releasePath)}`,
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(headStubPath, 0o755);

    return run({ commandLogPath, headArgsPath, releasePath, statCountPath, stubDir });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function spawnSetupJetson(
  stubDir: string,
  headArgsPath: string,
  commandLogPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
): SetupJetsonRun {
  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    headArgs: readFileSync(headArgsPath, "utf-8").trim(),
    commandLog: readFileSync(commandLogPath, "utf-8").trim(),
  };
}

function runSetupJetson(releaseLine: string): SetupJetsonRun {
  return withJetsonReleaseSandbox(({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
    writeFileSync(releasePath, `${releaseLine}\n`);
    return spawnSetupJetson(stubDir, headArgsPath, commandLogPath);
  });
}

function runSetupJetsonWithoutReleaseFile(): SetupJetsonRun {
  return withJetsonReleaseSandbox(({ commandLogPath, headArgsPath, stubDir }) =>
    spawnSetupJetson(stubDir, headArgsPath, commandLogPath),
  );
}

function extractDaemonJsonPatcher(): string {
  const script = readFileSync(SCRIPT_PATH, "utf-8");
  const match = script.match(/<<'PYEOF'\n([\s\S]*?)\nPYEOF/);
  if (!match) {
    throw new Error("Failed to extract inline daemon.json patcher from scripts/setup-jetson.sh");
  }
  return match[1];
}

function runDaemonJsonPatcher(daemonPath: string): void {
  execFileSync("python3", ["-", daemonPath], {
    input: extractDaemonJsonPatcher(),
    encoding: "utf-8",
  });
}

function getExecErrorOutput(error: Error | string | null | undefined): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = "stderr" in error ? error.stderr : "";
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf-8");
  }
  return error.message;
}

describe("setup-jetson daemon.json patcher", () => {
  it("repairs the missing-comma regression and removes iptables and bridge keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      writeFileSync(
        daemonPath,
        [
          "{",
          '  "default-runtime": "nvidia"',
          '  "runtimes": {',
          '    "nvidia": {',
          '      "path": "nvidia-container-runtime",',
          '      "runtimeArgs": []',
          "    }",
          "  },",
          '  "iptables": false,',
          '  "bridge": "none"',
          "}",
          "",
        ].join("\n"),
      );
      chmodSync(daemonPath, 0o640);

      runDaemonJsonPatcher(daemonPath);

      const patched = readFileSync(daemonPath, "utf-8");
      const parsed: {
        "default-runtime": string;
        runtimes: {
          nvidia: {
            path: string;
            runtimeArgs: [];
          };
        };
      } = JSON.parse(patched);

      expect(parsed).toEqual({
        "default-runtime": "nvidia",
        runtimes: {
          nvidia: {
            path: "nvidia-container-runtime",
            runtimeArgs: [],
          },
        },
      });
      expect(patched.endsWith("\n")).toBe(true);
      expect(statSync(daemonPath).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly for unrecoverable malformed JSON without clobbering the file", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");
    const original = '{"default-runtime": "nvidia",\n';

    try {
      writeFileSync(daemonPath, original);

      expect(() => runDaemonJsonPatcher(daemonPath)).toThrowError(
        /daemon\.json is malformed and could not be repaired automatically/,
      );
      expect(readFileSync(daemonPath, "utf-8")).toBe(original);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-object JSON roots before mutating keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      writeFileSync(daemonPath, '["not", "an", "object"]\n');

      let output = "";
      try {
        runDaemonJsonPatcher(daemonPath);
      } catch (error) {
        output = getExecErrorOutput(error instanceof Error ? error : String(error));
      }

      expect(output).toContain("daemon.json must contain a top-level JSON object");
      expect(readFileSync(daemonPath, "utf-8")).toBe('["not", "an", "object"]\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a new daemon.json with 0644 permissions when the file is missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-patcher-"));
    const daemonPath = path.join(tempDir, "daemon.json");

    try {
      runDaemonJsonPatcher(daemonPath);

      expect(readFileSync(daemonPath, "utf-8")).toBe("{}\n");
      expect(statSync(daemonPath).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("setup-jetson host setup on an unrecognized L4T release (#7612)", () => {
  it("names the skipped host setup, its consequence, the recognized releases, and that installation continues", () => {
    const result = runSetupJetson("# R35 (release), REVISION: 4.1, GCID: 12345678, BOARD: t186ref");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Jetson detected (L4T 35.4) but this L4T release is not recognized.",
    );
    expect(result.stderr).toContain("Skipped Jetson host setup");
    expect(result.stderr).toContain("iptables legacy mode");
    expect(result.stderr).toContain("br_netfilter");
    expect(result.stderr).toContain("sandbox pods cannot reach CoreDNS");
    expect(result.stderr).toContain(
      "Recognized L4T releases: 36.x (JetPack 6), 38.x (JetPack 7), and 39.x or later (JetPack 7).",
    );
    expect(result.stderr).toContain("Installation continues in an untested configuration.");
  });

  it("keeps the warning off stdout so the resolved version stays empty", () => {
    const result = runSetupJetson("# R35 (release), REVISION: 4.1, GCID: 12345678, BOARD: t186ref");

    expect(result.stdout).toBe("");
  });

  it("warns with the same detail when the release line cannot be parsed", () => {
    const result = runSetupJetson("not a tegra release line");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Jetson detected but the L4T release could not be parsed");
    expect(result.stderr).toContain("Skipped Jetson host setup");
    expect(result.stderr).toContain("Installation continues in an untested configuration.");
    expect(result.stdout).toBe("");
  });

  it("treats a missing revision as a parse failure instead of selecting a release family", () => {
    const result = runSetupJetson("# R36 (release), GCID: 12345678, BOARD: t186ref");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Jetson detected but the L4T release could not be parsed");
    expect(result.stderr).toContain("Skipped Jetson host setup");
    expect(result.stderr).toContain("Installation continues in an untested configuration.");
    expect(result.stdout).toBe("");
  });

  it("stays silent on a host that is not a Jetson", () => {
    const result = runSetupJetsonWithoutReleaseFile();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("ignores an inherited test release-path override during normal installation", () => {
    const result = withJetsonReleaseSandbox(
      ({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
        const inheritedOverridePath = path.join(path.dirname(releasePath), "inherited-release");
        writeFileSync(
          inheritedOverridePath,
          "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
        );
        return spawnSetupJetson(stubDir, headArgsPath, commandLogPath, {
          NEMOCLAW_TEST_NV_TEGRA_RELEASE_PATH: inheritedOverridePath,
        });
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.headArgs).toBe("-n1 /etc/nv_tegra_release");
  });

  it("resolves a recognized release to its host configuration without warning", () => {
    const result = runSetupJetson("# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Jetson detected (jp6)");
    expect(result.stderr).not.toContain("Skipped Jetson host setup");
  });
});

describe("setup-jetson JetPack 6 nvmap access", () => {
  it("grants the nvmap owning group read-write access and persists the mode on JetPack 6 (#7610)", () => {
    const result = withJetsonReleaseSandbox(
      ({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
        writeFileSync(
          releasePath,
          "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
        );
        return spawnSetupJetson(stubDir, headArgsPath, commandLogPath, {
          NEMOCLAW_TEST_STAT_OUTPUT: "character special file|cr--r-----",
          NEMOCLAW_TEST_STAT_OUTPUT_AFTER: "character special file|cr--rw----",
        });
      },
    );

    expect(result.status).toBe(0);
    expect(result.commandLog).toContain("tee /etc/udev/rules.d/99-zz-nemoclaw-nvmap.rules");
    expect(result.commandLog).toContain('stdin KERNEL=="nvmap", MODE="0660"');
    expect(result.commandLog).toContain("udevadm control --reload-rules");
    expect(result.commandLog).toContain("chmod g+rw /dev/nvmap");
    expect(result.stdout).toContain("/dev/nvmap grants its owning group read-write access");
    expect(result.stdout).toContain("preserves this mode after reboot");
    expect(result.stderr).toContain(
      "grants every member of the existing /dev/nvmap owning group write access",
    );
    expect(result.stderr).toContain("persists mode 0660 when udev recreates the device");
  });

  it("rejects a non-device nvmap path before changing host permissions (#7610)", () => {
    const result = withJetsonReleaseSandbox(
      ({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
        writeFileSync(
          releasePath,
          "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
        );
        return spawnSetupJetson(stubDir, headArgsPath, commandLogPath, {
          NEMOCLAW_TEST_STAT_OUTPUT: "regular file|-rw-r-----",
        });
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/dev/nvmap must be a character device");
    expect(result.commandLog).not.toContain("tee /etc/udev/rules.d/99-zz-nemoclaw-nvmap.rules");
    expect(result.commandLog).not.toContain("chmod g+rw /dev/nvmap");
  });

  it("skips nvmap host changes when the device is absent (#7610)", () => {
    const result = withJetsonReleaseSandbox(
      ({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
        writeFileSync(
          releasePath,
          "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
        );
        return spawnSetupJetson(stubDir, headArgsPath, commandLogPath);
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not find /dev/nvmap");
    expect(result.commandLog).not.toContain("tee /etc/udev/rules.d/99-zz-nemoclaw-nvmap.rules");
    expect(result.commandLog).not.toContain("chmod g+rw /dev/nvmap");
    expect(result.stdout).not.toContain("/dev/nvmap grants its owning group read-write access");
  });

  it("fails when nvmap remains read-only after host setup (#7610)", () => {
    const result = withJetsonReleaseSandbox(
      ({ commandLogPath, headArgsPath, releasePath, stubDir }) => {
        writeFileSync(
          releasePath,
          "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
        );
        return spawnSetupJetson(stubDir, headArgsPath, commandLogPath, {
          NEMOCLAW_TEST_STAT_OUTPUT: "character special file|cr--r-----",
          NEMOCLAW_TEST_STAT_OUTPUT_AFTER: "character special file|cr--r-----",
        });
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "/dev/nvmap does not grant its owning group read-write access after host setup",
    );
    expect(result.commandLog).toContain("chmod g+rw /dev/nvmap");
  });
});
