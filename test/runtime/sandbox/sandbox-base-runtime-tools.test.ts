// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_APT_SECURITY_FUNCTIONS } from "../../helpers/base-apt-security-functions";
import { dockerRunCommandBetween, runLoggedDockerShell } from "../../helpers/dockerfile-run-shell";
import { stageFixedParser, useRealPatchedParser } from "../../helpers/python-parser-security-fixture";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const MANAGED_BASE_DOCKERFILES = [
  DOCKERFILE_BASE,
  path.join(ROOT, "agents", "hermes", "Dockerfile.base"),
  path.join(ROOT, "agents", "langchain-deepagents-code", "Dockerfile.base"),
] as const;
const fixtures: string[] = [];

type RuntimeToolsFixture = "valid" | "missing-setpriv" | "gosu-present";

function writeSetprivFixture(setpriv: string) {
  fs.writeFileSync(setpriv, "#!/usr/bin/env bash\nprintf 'setpriv fixture\\n'\n", {
    mode: 0o755,
  });
}

const RUNTIME_TOOLS_FIXTURES: Record<
  RuntimeToolsFixture,
  (setpriv: string, fakeBin: string) => void
> = {
  valid: (setpriv) => writeSetprivFixture(setpriv),
  "missing-setpriv": () => undefined,
  "gosu-present": (setpriv, fakeBin) => {
    writeSetprivFixture(setpriv);
    fs.writeFileSync(path.join(fakeBin, "gosu"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
  },
};

function runRuntimeToolsContract(dockerfile: string, fixture: RuntimeToolsFixture) {
  const source = fs.readFileSync(dockerfile, "utf-8");
  const runtimeContract = dockerRunCommandBetween(
    source,
    "# setpriv runtime contract",
    "RUN groupadd",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-tools-"));
  fixtures.push(tmp);
  const fakeBin = path.join(tmp, "bin");
  const setpriv = path.join(tmp, "usr", "bin", "setpriv");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(setpriv), { recursive: true });
  fs.symlinkSync("/bin/bash", path.join(fakeBin, "bash"));
  RUNTIME_TOOLS_FIXTURES[fixture](setpriv, fakeBin);
  return runLoggedDockerShell(runtimeContract.replaceAll("/usr/bin/setpriv", setpriv), tmp, [], {
    env: { PATH: fakeBin },
  }).result;
}

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
    "# setpriv runtime contract",
  )
    .replaceAll("/var/lib/apt/lists", lists)
    .replaceAll("/tmp/nemoclaw-debian-security", debianSecurityDebs)
    .replaceAll("/tmp/nemoclaw-native-security", nativeSecurityDebs)
    .replaceAll("/usr/local/share/nemoclaw", path.join(tmp, "security-inventory"))
    .replaceAll("/usr/local/bin/python", fakePythonLink)
    .replaceAll("/usr/bin/python3", pythonShim)
    .replaceAll("/usr/lib/python3.13/html/parser.py", fixedParser);
  const { calls, result } = runLoggedDockerShell(
    command,
    tmp,
    [
      'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
      'install() { [[ "$#" -eq 8 && "$1" == "-d" && "$2" == "-o" && "$3" == "root" && "$4" == "-g" && "$5" == "root" && "$6" == "-m" && "$7" == "0755" ]] || return 64; mkdir -p "$8"; }',
      'chown() { [[ "$#" -eq 2 && "$1" == "root:root" ]] || return 64; }',
      ...useRealPatchedParser(BASE_APT_SECURITY_FUNCTIONS, pythonShim),
    ],
    { timeoutMs: 15_000 },
  );
  return { calls, fakePythonLink, pythonShim, result };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("sandbox base runtime tools", () => {
  it.each(
    MANAGED_BASE_DOCKERFILES,
  )("%s declares the setpriv and gosu build contract (#8805)", (dockerfile) => {
    const source = fs.readFileSync(dockerfile, "utf-8");
    const runtimeContract = dockerRunCommandBetween(
      source,
      "# setpriv runtime contract",
      "RUN groupadd",
    );

    expect(source).toContain("util-linux=2.41-5");
    expect(runtimeContract).toContain("test -x /usr/bin/setpriv");
    expect(runtimeContract).toContain("/usr/bin/setpriv --version");
    expect(runtimeContract).toContain("! command -v gosu");
  });

  it.each(
    MANAGED_BASE_DOCKERFILES,
  )("%s accepts executable setpriv when gosu is absent (#8805)", (dockerfile) => {
    const result = runRuntimeToolsContract(dockerfile, "valid");

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("setpriv fixture");
  });

  it.each(
    MANAGED_BASE_DOCKERFILES,
  )("%s rejects a missing setpriv executable (#8805)", (dockerfile) => {
    const result = runRuntimeToolsContract(dockerfile, "missing-setpriv");

    expect(result.status).not.toBe(0);
  });

  it.each(MANAGED_BASE_DOCKERFILES)("%s rejects gosu on PATH (#8805)", (dockerfile) => {
    const result = runRuntimeToolsContract(dockerfile, "gosu-present");

    expect(result.status).not.toBe(0);
  });

  it("installs the required process, filesystem, and SFTP tools", () => {
    const { calls, result } = runBaseAptLayer("nemoclaw-base-apt-");

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(calls).toContain("procps=2:4.0.4-9");
    expect(calls).toContain("util-linux=2.41-5");
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
