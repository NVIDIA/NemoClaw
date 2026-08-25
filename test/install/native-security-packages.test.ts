// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BUILD_SCRIPT = path.join(ROOT, "scripts", "security", "build-native-security-packages.sh");
const LIBSSH2_PATCH = path.join(
  ROOT,
  "scripts",
  "security",
  "patches",
  "libssh2-1.11.1-cve-2026.patch",
);
const PYTHON_PATCH = path.join(
  ROOT,
  "scripts",
  "security",
  "patches",
  "python3.13-htmlparser-cve-2026-15308.patch",
);
const BASE_DOCKERFILES = [
  path.join(ROOT, "Dockerfile.base"),
  path.join(ROOT, "agents", "hermes", "Dockerfile.base"),
  path.join(ROOT, "agents", "langchain-deepagents-code", "Dockerfile.base"),
] as const;

function runLibssh2Harness(nestedFailure = false) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-libssh2-harness-"));
  const testsDir = path.join(fixture, "tests");
  const harnessLog = path.join(fixture, "harness-log");
  fs.mkdirSync(path.join(testsDir, "openssh_server"), { recursive: true });
  fs.mkdirSync(harnessLog);
  fs.writeFileSync(
    path.join(testsDir, "Makefile.inc"),
    [
      `DOCKER_TESTS = ${Array.from({ length: 22 }, (_, index) => `docker-${index + 1}`).join(" ")}`,
      "SSHD_TESTS = sshd-1 sshd-2",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(testsDir, "test_read_algos.txt"),
    `${Array.from({ length: 18 }, (_, index) => `algorithm-${index + 1}`).join("\n")}\n`,
  );
  fs.writeFileSync(path.join(testsDir, "openssh_server", "authorized_keys"), "fixture-key\n");
  fs.writeFileSync(
    path.join(testsDir, "test_sshd.test"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$USER|$LOGNAME|$SSHD_FLAGS" >"$HARNESS_LOG/environment"',
      'printf "%s\\n" "$@" >"$HARNESS_LOG/arguments"',
      'printf "1..25\\n"',
      'if [[ "${NESTED_FAILURE:-0}" == "1" ]]; then',
      '  printf "not ok 7 - nested algorithm\\n"',
      "else",
      '  printf "ok 25 - all upstream cases\\n"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'calls="$HARNESS_LOG/calls"',
        'mapfile() { local target="$2" line; eval "$target=()"; while IFS= read -r line; do eval "$target+=(\\"\\$line\\")"; done; }',
        'chmod() { printf "chmod %s\\n" "$*" >>"$calls"; }',
        "id() { return 0; }",
        'useradd() { printf "useradd %s\\n" "$*" >>"$calls"; }',
        'chpasswd() { cat >/dev/null; printf "chpasswd\\n" >>"$calls"; }',
        'install() { printf "install %s\\n" "$*" >>"$calls"; }',
        'sed() { printf "sed %s\\n" "$*" >>"$calls"; }',
        'make() { printf "make %s\\n" "$*" >>"$calls"; }',
        'run_libssh2_tests "$2"',
      ].join("\n"),
      "libssh2-harness",
      BUILD_SCRIPT,
      fixture,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HARNESS_LOG: harnessLog,
        NESTED_FAILURE: nestedFailure ? "1" : "0",
      },
    },
  );
  return { fixture, harnessLog, result };
}

describe("native security package remediation", () => {
  it("keeps the package builder syntactically valid", () => {
    const result = spawnSync("bash", ["-n", BUILD_SCRIPT], { encoding: "utf-8" });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("runs every upstream libssh2 case against the local OpenSSH fixture", () => {
    const { fixture, harnessLog, result } = runLibssh2Harness();
    try {
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(result.stdout).toContain("ok 25 - all upstream cases");
      expect(fs.readFileSync(path.join(harnessLog, "calls"), "utf-8")).toContain("make check");
      const argumentsList = fs
        .readFileSync(path.join(harnessLog, "arguments"), "utf-8")
        .trim()
        .split("\n");
      expect(argumentsList).toEqual([
        ...Array.from({ length: 22 }, (_, index) => `./docker-${index + 1}`),
        "./sshd-1",
        "./sshd-2",
        "./test_read_algos.test",
      ]);
      expect(fs.readFileSync(path.join(harnessLog, "environment"), "utf-8").trim()).toBe(
        "libssh2|libssh2|-o UsePAM=yes -o KbdInteractiveAuthentication=yes -o PasswordAuthentication=yes -o PerSourcePenalties=no",
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects a nested libssh2 TAP failure", () => {
    const { fixture, result } = runLibssh2Harness(true);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("A nested libssh2 TAP test reported a failure.");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("records every reviewed upstream fix at the patch boundary", () => {
    const libssh2Patch = fs.readFileSync(LIBSSH2_PATCH, "utf-8");
    expect([
          "5e4776146552d898b9c0e1b313cd093fa8dc92d0",
          "a2ed82d40964bbc0d64cd717aa0a5a892117d2e6",
          "a13bb6c773f0d55ad1628cede57e99803cd898d9",
          "42e33d81577ed4b95d4b4f6f845e5ee8efe5eeb4",
          "a9758da45a52bc8c630ec9493804d0c6ea30b24a",
          "7c8a170c6dca3cd4cf24de836f43ba1a20e662d5",
        ].every((commit) => libssh2Patch.includes(commit))).toBe(true);
    expect(libssh2Patch).toContain("blocksize > sizeof(buf)");
    expect(libssh2Patch).toContain("pkey->listFetch_s + comment_len");
    expect(libssh2Patch).toContain("data = NULL");
    expect(libssh2Patch).toContain("p->total_num < mac_len + 4 + (size_t)blocksize");
    expect(libssh2Patch).toContain("memset(&list[keys], 0, sizeof(list[keys]))");
    expect(([
          ["Public key description too large", 2],
          ["Public key language too large", 2],
          ["Public key comment too large", 1],
          ["Public key name too large", 2],
          ["Public key blob too large", 2],
          ["Public key attribute name too large", 1],
          ["Public key attribute value too large", 1],
        ] as const).every(([rejectedElement, expectedChecks]) =>
          libssh2Patch.split(rejectedElement).length === expectedChecks + 1)).toBe(true);

    const pythonPatch = fs.readFileSync(PYTHON_PATCH, "utf-8");
    expect(pythonPatch).toContain("7933f4bf7131aa4140750f9404f5de0aa2969ced");
    expect(pythonPatch).toContain("if not data:");
    expect(pythonPatch).toContain("self._pending_len += len(data)");
    expect(pythonPatch).toContain("self._parse_threshold = len(self.rawdata)");
  });

  it.each(BASE_DOCKERFILES)("wires both native packages into %s", (dockerfile) => {
    const content = fs.readFileSync(dockerfile, "utf-8");
    expect(content).toContain("AS native-security-builder");
    expect(content).toContain(
      "COPY scripts/security/build-native-security-packages.sh /scripts/security/build-native-security-packages.sh",
    );
    expect(content).toContain(
      "COPY scripts/security/patches/libssh2-1.11.1-cve-2026.patch /scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
    );
    expect(content).toContain(
      "COPY scripts/security/patches/python3.13-htmlparser-cve-2026-15308.patch /scripts/security/patches/python3.13-htmlparser-cve-2026-15308.patch",
    );
    expect(content).toContain("bash /scripts/security/build-native-security-packages.sh /out");
    expect(content).toContain("openssh-server=1:10.0p1-7+deb13u4");
    expect(content).toContain("/tmp/nemoclaw-native-security/libssh2-1t64.deb");
    expect(content).toContain(
      "/tmp/nemoclaw-native-security/nemoclaw-python3.13-htmlparser-fix.deb",
    );
    expect(content).toContain("libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2");
    expect(content).toContain("nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1");
    expect(content).toContain("4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7");
    expect(content).toContain("[p.feed('') for _ in range(20000)]");
    expect(content).toContain("or sys.exit('empty feeds accumulated pending entries')");
    expect(content).toContain(
      "lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')",
    );
  });
});
