// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SSH_WRAPPER = path.join(REPO_ROOT, "scripts", "nemoclaw-ssh.sh");
const tempDirs: string[] = [];

function helperEntrypoint(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ssh-entrypoint-"));
  tempDirs.push(dir);
  const link = path.join(dir, name);
  fs.symlinkSync(SSH_WRAPPER, link);
  return link;
}

function fakeNc(): { binDir: string; argsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-nc-"));
  tempDirs.push(dir);
  const binDir = path.join(dir, "bin");
  const argsPath = path.join(dir, "nc-args.txt");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "nc"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$NEMOCLAW_TEST_NC_ARGS"\n',
    { mode: 0o755 },
  );
  return { binDir, argsPath };
}

function helperPath(fakeNcBinDir: string): string {
  return [fakeNcBinDir, "/usr/bin", "/bin"].join(":");
}

describe("nemoclaw OpenSSH proxy helper", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("execs netcat in HTTP CONNECT mode when an HTTP proxy is configured", () => {
    const { binDir, argsPath } = fakeNc();
    const result = spawnSync(
      "/bin/sh",
      [helperEntrypoint("nemoclaw-ssh-proxy"), "ssh.example.test", "22"],
      {
        encoding: "utf-8",
        env: {
          PATH: helperPath(binDir),
          HTTPS_PROXY: "http://127.0.0.1:3128",
          NEMOCLAW_TEST_NC_ARGS: argsPath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(argsPath, "utf-8").trim().split("\n")).toEqual([
      "-X",
      "connect",
      "-x",
      "127.0.0.1:3128",
      "ssh.example.test",
      "22",
    ]);
  });

  it("execs direct netcat when no proxy is configured", () => {
    const { binDir, argsPath } = fakeNc();
    const result = spawnSync(
      "/bin/sh",
      [helperEntrypoint("nemoclaw-ssh-proxy"), "ssh.example.test", "22"],
      {
        encoding: "utf-8",
        env: {
          PATH: helperPath(binDir),
          NEMOCLAW_TEST_NC_ARGS: argsPath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(argsPath, "utf-8").trim().split("\n")).toEqual([
      "ssh.example.test",
      "22",
    ]);
  });

  it("resolves explicit hosts-file aliases before dialing the proxy", () => {
    const { binDir, argsPath } = fakeNc();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ssh-hosts-"));
    tempDirs.push(dir);
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(
      hostsPath,
      [
        "# local sandbox aliases",
        "127.0.0.1 localhost",
        "10.10.10.5 internal-bastion bastion.internal.test",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "/bin/sh",
      [helperEntrypoint("nemoclaw-ssh-proxy"), "internal-bastion", "22"],
      {
        encoding: "utf-8",
        env: {
          PATH: helperPath(binDir),
          HTTPS_PROXY: "http://127.0.0.1:3128",
          NEMOCLAW_SSH_HOSTS_FILE: hostsPath,
          NEMOCLAW_TEST_NC_ARGS: argsPath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(argsPath, "utf-8").trim().split("\n")).toEqual([
      "-X",
      "connect",
      "-x",
      "127.0.0.1:3128",
      "10.10.10.5",
      "22",
    ]);
  });
});

describe("nemoclaw OpenSSH password prompt helpers", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("askpass helper can read a password from inherited stdin when explicitly allowed", () => {
    const result = spawnSync("/bin/sh", [helperEntrypoint("nemoclaw-ssh-askpass"), "Password:"], {
      encoding: "utf-8",
      input: "secret\n",
      env: {
        NEMOCLAW_SSH_ASKPASS_ALLOW_STDIN: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("secret\n");
    expect(result.stderr).toContain("Password:");
  });

  it("askpass helper reads the input path exported by the ssh wrapper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-askpass-input-"));
    tempDirs.push(dir);
    const inputPath = path.join(dir, "stdin");
    fs.writeFileSync(inputPath, "secret-from-wrapper\n");

    const result = spawnSync("/bin/sh", [helperEntrypoint("nemoclaw-ssh-askpass"), "Password:"], {
      encoding: "utf-8",
      env: {
        NEMOCLAW_SSH_ASKPASS_INPUT: inputPath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("secret-from-wrapper\n");
    expect(result.stderr).toContain("Password:");
  });

  it("ssh wrapper enables askpass before delegating to the real OpenSSH binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-ssh-"));
    tempDirs.push(dir);
    const fakeSsh = path.join(dir, "ssh");
    fs.writeFileSync(
      fakeSsh,
      [
        "#!/bin/sh",
        'printf "SSH_ASKPASS=%s\\n" "$SSH_ASKPASS"',
        'printf "SSH_ASKPASS_REQUIRE=%s\\n" "$SSH_ASKPASS_REQUIRE"',
        'printf "DISPLAY=%s\\n" "$DISPLAY"',
        'printf "ARGS=%s\\n" "$*"',
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("/bin/sh", [SSH_WRAPPER, "example.test"], {
      encoding: "utf-8",
      env: {
        NEMOCLAW_REAL_SSH: fakeSsh,
        NEMOCLAW_SSH_FORCE_ASKPASS: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SSH_ASKPASS=/usr/local/bin/nemoclaw-ssh-askpass");
    expect(result.stdout).toContain("SSH_ASKPASS_REQUIRE=force");
    expect(result.stdout).toContain("DISPLAY=nemoclaw");
    expect(result.stdout).toContain("ARGS=example.test");
  });
});
