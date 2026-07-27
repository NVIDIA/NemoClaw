// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
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

describe("native security package remediation", () => {
  it("keeps the package builder syntactically valid", () => {
    const result = spawnSync("bash", ["-n", BUILD_SCRIPT], { encoding: "utf-8" });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("records every reviewed upstream fix at the patch boundary", () => {
    const libssh2Patch = fs.readFileSync(LIBSSH2_PATCH, "utf-8");
    for (const commit of [
      "5e4776146552d898b9c0e1b313cd093fa8dc92d0",
      "a2ed82d40964bbc0d64cd717aa0a5a892117d2e6",
      "a13bb6c773f0d55ad1628cede57e99803cd898d9",
      "42e33d81577ed4b95d4b4f6f845e5ee8efe5eeb4",
    ]) {
      expect(libssh2Patch).toContain(commit);
    }
    expect(libssh2Patch).toContain("blocksize > sizeof(buf)");
    expect(libssh2Patch).toContain("pkey->listFetch_s + comment_len");
    expect(libssh2Patch).toContain("data = NULL");
    expect(libssh2Patch).toContain("p->total_num < mac_len + 4 + (size_t)blocksize");

    const pythonPatch = fs.readFileSync(PYTHON_PATCH, "utf-8");
    expect(pythonPatch).toContain("7933f4bf7131aa4140750f9404f5de0aa2969ced");
    expect(pythonPatch).toContain("self._pending_len += len(data)");
    expect(pythonPatch).toContain("self._parse_threshold = len(self.rawdata)");
  });

  it.each(BASE_DOCKERFILES)("installs and proves both native packages in %s", (dockerfile) => {
    const content = fs.readFileSync(dockerfile, "utf-8");
    expect(content).toContain("AS native-security-builder");
    expect(content).toContain("COPY scripts/security /scripts/security");
    expect(content).toContain("bash /scripts/security/build-native-security-packages.sh /out");
    expect(content).toContain("openssh-server=1:10.0p1-7+deb13u4");
    expect(content).toContain("/tmp/nemoclaw-native-security/libssh2-1t64.deb");
    expect(content).toContain(
      "/tmp/nemoclaw-native-security/nemoclaw-python3.13-htmlparser-fix.deb",
    );
    expect(content).toContain("libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1");
    expect(content).toContain("nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1");
    expect(content).toContain("33a7eeead8d1ccb04efd282502b766e44c36cca17bbb44d9e6fa3911fd8f226f");
    expect(content).toContain("lib.libssh2_version(0) == b'1.11.1'");
  });
});
