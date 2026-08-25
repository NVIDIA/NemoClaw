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

const SCRIPT_PATH = path.join(import.meta.dirname, "../..", "scripts", "setup-jetson.sh");

const HOST_MUTATION_COMMANDS = [
  "sudo",
  "modprobe",
  "sysctl",
  "tee",
  "update-alternatives",
  "systemctl",
  "python3",
];

type SetupJetsonRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  headArgs: string;
};

function withJetsonReleaseSandbox<T>(
  run: (paths: { headArgsPath: string; releasePath: string; stubDir: string }) => T,
): T {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-jetson-release-"));

  try {
    const stubDir = path.join(tempDir, "bin");
    const headArgsPath = path.join(tempDir, "head-args");
    const releasePath = path.join(tempDir, "nv_tegra_release");
    mkdirSync(stubDir);
    for (const command of HOST_MUTATION_COMMANDS) {
      const stubPath = path.join(stubDir, command);
      writeFileSync(stubPath, "#!/usr/bin/env bash\nexit 0\n");
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

    return run({ headArgsPath, releasePath, stubDir });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function spawnSetupJetson(
  stubDir: string,
  headArgsPath: string,
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
  };
}

function runSetupJetson(releaseLine: string): SetupJetsonRun {
  return withJetsonReleaseSandbox(({ headArgsPath, releasePath, stubDir }) => {
    writeFileSync(releasePath, `${releaseLine}\n`);
    return spawnSetupJetson(stubDir, headArgsPath);
  });
}

function runSetupJetsonWithoutReleaseFile(): SetupJetsonRun {
  return withJetsonReleaseSandbox(({ headArgsPath, stubDir }) =>
    spawnSetupJetson(stubDir, headArgsPath),
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
    const result = withJetsonReleaseSandbox(({ headArgsPath, releasePath, stubDir }) => {
      const inheritedOverridePath = path.join(path.dirname(releasePath), "inherited-release");
      writeFileSync(
        inheritedOverridePath,
        "# R36 (release), REVISION: 5.1, GCID: 12345678, BOARD: t186ref\n",
      );
      return spawnSetupJetson(stubDir, headArgsPath, {
        NEMOCLAW_TEST_NV_TEGRA_RELEASE_PATH: inheritedOverridePath,
      });
    });

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
