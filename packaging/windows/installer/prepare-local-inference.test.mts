// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const python = process.env.NEMOCLAW_TEST_PYTHON ?? "python";
const prepare = fileURLToPath(new URL("./prepare_local_inference.py", import.meta.url));
const prefix = "app/resources/agent-payload/tools/llamacpp-cuda-10362-win32-arm64/";
const binaries = [
  "llama-server.exe",
  "llama-server-impl.dll",
  "llama.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml-cuda.dll",
  "cudart64_13.dll",
  "cublas64_13.dll",
  "cublasLt64_13.dll",
];
type Entry = { name: string; content: Buffer; mode?: number };

function zip(entries: Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(entry.content), 14);
    header.writeUInt32LE(entry.content.length, 18);
    header.writeUInt32LE(entry.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    header.copy(record, 6, 4, 26);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(t: TestContext, change: (entries: Entry[]) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-intake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 60);
  pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0xaa64, 68);
  const entries: Entry[] = [
    {
      name: "AppxManifest.xml",
      content: Buffer.from(
        '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="fixture" Version="1.0.0.0" ProcessorArchitecture="arm64"/></Package>',
      ),
    },
    {
      name: "app/resources/agent-payload/manifest.json",
      content: Buffer.from(JSON.stringify({ ref: "a".repeat(40), target: "win32-arm64" })),
    },
    ...binaries.map((name) => ({ name: prefix + name, content: Buffer.from(pe) })),
    { name: "app/hermes.exe", content: Buffer.from("must not be copied or executed") },
  ];
  change(entries);
  const bytes = zip(entries);
  const bundle = path.join(root, "fixture.msix");
  const output = path.join(root, "prepared");
  fs.writeFileSync(bundle, bytes);
  const catalog = {
    engine: {
      version: "b10362",
      architecture: "arm64",
      backend: "cuda",
      prefix,
      bundleBytes: bytes.length,
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      packageIdentity: "fixture",
      packageVersion: "1.0.0.0",
      sourceRevision: "a".repeat(40),
    },
  };
  const run = () =>
    spawnSync(
      python,
      [
        "-B",
        "-c",
        [
          "import importlib.util,json,pathlib,sys",
          "spec=importlib.util.spec_from_file_location('intake',sys.argv[1])",
          "module=importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "result=module.prepare(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),json.load(sys.stdin))",
          "print(json.dumps(result))",
        ].join(";"),
        prepare,
        bundle,
        output,
      ],
      {
        input: JSON.stringify(catalog),
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
  return { root, bundle, output, catalog, run };
}

test("verified ARM64 bundle yields runtime files without copying Hermes or claiming model readiness", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.files.length, binaries.length);
  assert.equal(receipt.modelsBundled, false);
  assert.equal(receipt.signatureVerified, false);
  assert.equal(receipt.redistributionApproved, false);
  assert.equal(receipt.qualification, "not-run");
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["bin", "runtime.json"]);
  assert.deepEqual(fs.readdirSync(path.join(f.output, "bin")).sort(), [...binaries].sort());
  for (const row of receipt.files) {
    const bytes = fs.readFileSync(path.join(f.output, row.path));
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
  }
});

test("wrong archive digest fails before output creation", (t) => {
  const f = fixture(t);
  f.catalog.engine.bundleSha256 = "0".repeat(64);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned size or SHA-256/u);
  assert.equal(fs.existsSync(f.output), false);
});

for (const [name, change, expected] of [
  [
    "missing CUDA library",
    (entries: Entry[]) => {
      entries.splice(
        entries.findIndex((e) => e.name.endsWith("ggml-cuda.dll")),
        1,
      );
    },
    /incomplete/u,
  ],
  [
    "path traversal",
    (entries: Entry[]) => {
      entries.push({ name: prefix + "../escape.exe", content: entries[2].content });
    },
    /unsafe/u,
  ],
  [
    "case-colliding binary",
    (entries: Entry[]) => {
      entries.push({ name: prefix + "LLAMA-SERVER.exe", content: entries[2].content });
    },
    /duplicate/u,
  ],
  [
    "symlink binary",
    (entries: Entry[]) => {
      entries[2].mode = 0o120777;
    },
    /unsupported entry/u,
  ],
  [
    "wrong package architecture",
    (entries: Entry[]) => {
      entries[0].content = Buffer.from(entries[0].content.toString().replace('="arm64"', '="x64"'));
    },
    /package identity/u,
  ],
  [
    "wrong payload revision",
    (entries: Entry[]) => {
      entries[1].content = Buffer.from(
        JSON.stringify({ ref: "b".repeat(40), target: "win32-arm64" }),
      );
    },
    /revision/u,
  ],
  [
    "x64 executable",
    (entries: Entry[]) => {
      entries[2].content.writeUInt16LE(0x8664, 68);
    },
    /not native ARM64/u,
  ],
  [
    "duplicate metadata",
    (entries: Entry[]) => {
      entries.push(entries[0]);
    },
    /duplicate entries/u,
  ],
] as const) {
  test(`rejects ${name} and leaves no partial runtime`, (t) => {
    const f = fixture(t, change);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(f.output), false);
    assert.equal(fs.existsSync(path.join(f.root, "escape.exe")), false);
  });
}

test("existing destination and its contents remain unchanged", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  const existing = path.join(f.output, "keep.txt");
  fs.writeFileSync(existing, "existing user data");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be fresh/u);
  assert.equal(fs.readFileSync(existing, "utf8"), "existing user data");
});
