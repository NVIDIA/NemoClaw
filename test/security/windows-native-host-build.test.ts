// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const owner = path.resolve("packaging/windows/installer/prepare-finished-host.py");
const python = process.platform === "win32" ? "python" : "python3";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const names = ["openshell.exe", "openshell-gateway.exe"];
type FileIdentity = { file: string; bytes: number; sha256: string };
const fileIdentityMutations: readonly {
  name: string;
  apply: (files: FileIdentity[]) => void;
}[] = [
  { name: "missing", apply: (files) => void files.pop() },
  { name: "duplicate", apply: (files) => (files[1] = { ...files[0]! }) },
  { name: "traversal", apply: (files) => (files[0]!.file = "../openshell.exe") },
  { name: "hash", apply: (files) => (files[0]!.sha256 = "b".repeat(64)) },
  { name: "size", apply: (files) => void files[0]!.bytes++ },
];
const invoke = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
root = pathlib.Path(sys.argv[2])
host.verify_openshell_build(root, root, "a" * 40, "123", "1")
`;

describe("current OpenShell installer build evidence", () => {
  let root: string;
  let receipt: Record<string, unknown>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-build-"));
    const patch = path.join(root, "packaging/windows/openshell-2721-node-ui.patch");
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(patch, "current derivative");
    // Minimal PE headers exercise identity checks; these files are never executed.
    const binary = Buffer.alloc(128);
    binary.write("MZ");
    binary.writeUInt32LE(64, 60);
    binary.write("PE\0\0", 64);
    binary.writeUInt16LE(0xaa64, 68);
    for (const name of names) fs.writeFileSync(path.join(root, name), binary);
    receipt = {
      schemaVersion: 1,
      classification: "ci-built-openshell-host-binaries",
      requestedSourceRevision: "a".repeat(40),
      openshellRevision: "bcd517bbe08cc80860c9be57699390cd32e8445f",
      derivativePatchSha256: hash("current derivative"),
      rustToolchain: "1.95.0-aarch64-pc-windows-msvc",
      rustTarget: "aarch64-pc-windows-msvc",
      workflowRunId: "123",
      workflowRunAttempt: "1",
      currentPackageQualification: false,
      files: names.map((file) => ({ file, bytes: binary.length, sha256: hash(binary) })),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function verify() {
    fs.writeFileSync(path.join(root, "openshell-build.json"), JSON.stringify(receipt));
    const result = spawnSync(python, ["-B", "-c", invoke, owner, root], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  it("accepts exactly the two same-run ARM64 binaries without claiming qualification", () => {
    const result = verify();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    ["classification", "ci-reused-openshell-host-binaries"],
    ["requestedSourceRevision", "b".repeat(40)],
    ["openshellRevision", "b".repeat(40)],
    ["derivativePatchSha256", "b".repeat(64)],
    ["workflowRunId", "122"],
    ["workflowRunAttempt", "2"],
    ["rustToolchain", "stable"],
    ["rustTarget", "x86_64-pc-windows-msvc"],
    ["currentPackageQualification", true],
  ])("rejects mismatched %s", (field, value) => {
    receipt[field as string] = value;
    expect(verify().status).not.toBe(0);
  });

  it.each(fileIdentityMutations)("rejects a $name file identity", ({ apply }) => {
    apply(receipt.files as FileIdentity[]);
    expect(verify().status).not.toBe(0);
  });

  it("rejects changed bytes even with an otherwise valid receipt", () => {
    fs.appendFileSync(path.join(root, names[0]), "changed");
    expect(verify().status).not.toBe(0);
  });

  it("rejects x64 executables even when their content hashes match", () => {
    const binary = fs.readFileSync(path.join(root, names[0]));
    binary.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(path.join(root, names[0]), binary);
    const files = receipt.files as { sha256: string }[];
    files[0].sha256 = hash(binary);
    expect(verify().status).not.toBe(0);
  });
});
