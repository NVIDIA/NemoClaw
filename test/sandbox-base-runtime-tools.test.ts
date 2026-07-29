// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_APT_SECURITY_FUNCTIONS,
  dockerRunCommandBetween,
  runLoggedDockerShell,
} from "./helpers/base-apt-security-functions";
import { stageFixedParser, useRealPatchedParser } from "./helpers/python-parser-security-fixture";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const fixtures: string[] = [];

function runBaseAptLayer(prefix: string) {
  const source = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
  const completedStage = source.lastIndexOf("\nFROM ");
  const dockerfile = completedStage >= 0 ? source.slice(completedStage) : source;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(tmp);
  const lists = path.join(tmp, "apt-lists");
  const debianSecurityDebs = path.join(tmp, "debian-security-debs");
  const nativeSecurityDebs = path.join(tmp, "native-security-debs");
  const fakePythonLink = path.join(tmp, "usr-local-bin", "python");
  const { fixedParser, pythonShim } = stageFixedParser(tmp);
  fs.mkdirSync(lists);
  fs.mkdirSync(debianSecurityDebs);
  fs.mkdirSync(nativeSecurityDebs);
  fs.mkdirSync(path.dirname(fakePythonLink), { recursive: true });
  fs.writeFileSync(path.join(nativeSecurityDebs, "libssh2-1t64.deb"), "fixed libssh2");
  fs.writeFileSync(
    path.join(nativeSecurityDebs, "nemoclaw-python3.13-htmlparser-fix.deb"),
    "fixed parser package",
  );
  const command = dockerRunCommandBetween(
    dockerfile,
    "RUN apt-get update",
    "# gosu for privilege separation",
  )
    .replaceAll("/var/lib/apt/lists", lists)
    .replaceAll("/tmp/nemoclaw-debian-security", debianSecurityDebs)
    .replaceAll("/tmp/nemoclaw-native-security", nativeSecurityDebs)
    .replaceAll("/usr/local/share/nemoclaw", path.join(tmp, "security-inventory"))
    .replaceAll("/usr/local/bin/python", fakePythonLink)
    .replaceAll("/usr/bin/python3", pythonShim)
    .replaceAll("/usr/lib/python3.13/html/parser.py", fixedParser);
  const result = runLoggedDockerShell(command, tmp, [
    'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
    'install() { [[ "$#" -eq 8 && "$1" == "-d" && "$2" == "-o" && "$3" == "root" && "$4" == "-g" && "$5" == "root" && "$6" == "-m" && "$7" == "0755" ]] || return 64; mkdir -p "$8"; }',
    'chown() { [[ "$#" -eq 2 && "$1" == "root:root" ]] || return 64; }',
    ...useRealPatchedParser(BASE_APT_SECURITY_FUNCTIONS, pythonShim),
  ]);
  const calls = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8");
  return { calls, fakePythonLink, pythonShim, result };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("sandbox base runtime tools", () => {
  it("installs the required process, filesystem, and SFTP tools", () => {
    const { calls, result } = runBaseAptLayer("nemoclaw-base-apt-");

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(calls).toContain("procps=2:4.0.4-9");
    expect(calls).toContain("e2fsprogs=1.47.2-3+b11");
    expect(calls).toContain("openssh-sftp-server=1:10.0p1-7+deb13u4");
  });

  it("symlinks bare `python` to the tested python3 interpreter (#1452)", () => {
    const { fakePythonLink, pythonShim, result } = runBaseAptLayer("nemoclaw-base-pysymlink-");

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(fs.lstatSync(fakePythonLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fakePythonLink)).toBe(pythonShim);
  });
});
