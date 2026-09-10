// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { command, commandPassed, fileIdentity } from "./probe-component-workload.mts";

for (const [machine, architecture] of [
  [0xaa64, "arm64"],
  [0x8664, "x64"],
  [0x14c, "x86"],
] as const) {
  test(`PE identity reports the actual ${architecture} machine and byte hash`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "component-pe-"));
    try {
      const bytes = Buffer.alloc(128);
      bytes.write("MZ");
      bytes.writeUInt32LE(64, 60);
      bytes.write("PE\u0000\u0000", 64);
      bytes.writeUInt16LE(machine, 68);
      const file = path.join(directory, "component.exe");
      fs.writeFileSync(file, bytes);
      const identity = fileIdentity(file);
      assert.equal(identity.architecture, architecture);
      assert.equal(identity.sha256, createHash("sha256").update(bytes).digest("hex"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("an actual child must exit successfully and print the exact sentinel", async () => {
  const result = await command(
    process.execPath,
    ["-e", "console.log('COMPONENT_OK')"],
    process.env,
    process.cwd(),
    3000,
  );
  assert.equal(commandPassed(result, "COMPONENT_OK"), true);
  assert.equal(commandPassed(result, "OK"), false);
});

test("a nonzero actual child preserves stderr and cannot pass with a sentinel", async () => {
  const result = await command(
    process.execPath,
    ["-e", "console.log('COMPONENT_OK'); console.error('actual failure'); process.exitCode=7"],
    process.env,
    process.cwd(),
    3000,
  );
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /actual failure/u);
  assert.equal(commandPassed(result, "COMPONENT_OK"), false);
});

test("a missing exact executable records spawn diagnostics without fallback", async () => {
  const file = path.join(process.cwd(), "missing-owned-component.exe");
  const result = await command(file, [], process.env, process.cwd(), 3000);
  assert.equal(result.error?.code, "ENOENT");
  assert.equal(result.executable, file);
  assert.equal(result.childClosed, true);
  assert.equal(commandPassed(result, "COMPONENT_OK"), false);
});

test("an actual hanging owned child is stopped at its deadline", async () => {
  const result = await command(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.env,
    process.cwd(),
    150,
  );
  assert.equal(result.timedOut, true);
  assert.ok(result.elapsedMs < 7000);
  assert.equal(commandPassed(result, "COMPONENT_OK"), false);
});

test("excessive child output is bounded and rejected", async () => {
  const result = await command(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(200000))"],
    process.env,
    process.cwd(),
    3000,
  );
  assert.equal(result.outputExceeded, true);
  assert.equal(result.stdout.length, 64 * 1024);
  assert.equal(commandPassed(result, "COMPONENT_OK"), false);
});

test("an actual child's Windows UTF-16LE diagnostics remain readable", async () => {
  const result = await command(
    process.execPath,
    [
      "-e",
      "process.stderr.write(Buffer.from('Access denied: shell.exe', 'utf16le')); process.exitCode=1",
    ],
    process.env,
    process.cwd(),
    3000,
  );
  assert.equal(result.stderr, "Access denied: shell.exe");
  assert.equal(result.exitCode, 1);
});

test("UTF-8 split between real child writes is decoded after collection", async () => {
  const result = await command(
    process.execPath,
    [
      "-e",
      "const b=Buffer.from('component 🐚 ready'); process.stdout.write(b.subarray(0,12)); setTimeout(()=>process.stdout.write(b.subarray(12)),50)",
    ],
    process.env,
    process.cwd(),
    3000,
  );
  assert.equal(result.stdout, "component 🐚 ready");
});
