// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveImage, imageChecksum, inspectPe } from "./prepare-msys-aslr.mts";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const data = Buffer.alloc(1536);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(128, 60);
  data.writeUInt32LE(0x4550, 128);
  data.writeUInt16LE(0x8664, 132);
  data.writeUInt16LE(2, 134);
  data.writeUInt16LE(240, 148);
  data.writeUInt16LE(0x2022, 150);
  const optional = 152;
  data.writeUInt16LE(0x20b, optional);
  data.writeBigUInt64LE(0x180000000n, optional + 24);
  data.writeUInt32LE(0x3000, optional + 56);
  data.writeUInt32LE(512, optional + 60);
  data.writeUInt32LE(16, optional + 108);
  data.writeUInt32LE(0x2000, optional + 152);
  data.writeUInt32LE(12, optional + 156);
  for (let i = 0; i < 2; i++) {
    const at = 392 + i * 40;
    data.write(i ? ".reloc" : ".text", at, "ascii");
    data.writeUInt32LE(512, at + 8);
    data.writeUInt32LE(0x1000 * (i + 1), at + 12);
    data.writeUInt32LE(512, at + 16);
    data.writeUInt32LE(512 * (i + 1), at + 20);
  }
  data.write("code-and-data-must-remain", 512);
  data.writeUInt32LE(0x1000, 1024);
  data.writeUInt32LE(12, 1028);
  data.writeUInt16LE(0xa010, 1032);
  data.writeUInt32LE(imageChecksum(data, 216), 216);
  return data;
}
test("only DYNAMIC_BASE and checksum change; original and every section remain intact", () => {
  const input = fixture(),
    copy = Buffer.from(input);
  const { output, receipt } = deriveImage(input, {
    bytes: input.length,
    sha256: sha(input),
    flags: 0,
  });
  assert(input.equals(copy));
  assert.equal(receipt.afterFlags, 0x40);
  assert.deepEqual(inspectPe(output).sections, inspectPe(input).sections);
  assert.equal(imageChecksum(output, receipt.checksumOffset), receipt.afterChecksum);
  for (let i = 0; i < input.length; i++)
    if (![216, 217, 218, 219, 222, 223].includes(i)) assert.equal(output[i], input[i]);
});
test("certificate-bearing images are rejected before adaptation", () => {
  const data = fixture();
  data.writeUInt32LE(1408, 296);
  data.writeUInt32LE(128, 300);
  assert.throws(() => inspectPe(data), /Signed images/u);
});
test("stripped or absent relocations cannot opt in", () => {
  const stripped = fixture();
  stripped.writeUInt16LE(0x2023, 150);
  assert.throws(() => inspectPe(stripped), /stripped/u);
  const absent = fixture();
  absent.writeUInt32LE(0, 304);
  assert.throws(() => inspectPe(absent));
});
test("truncated relocation blocks and unsupported fixups are rejected", () => {
  const truncated = fixture();
  truncated.writeUInt32LE(16, 1028);
  assert.throws(() => inspectPe(truncated));
  const unsupported = fixture();
  unsupported.writeUInt16LE(0x3010, 1032);
  assert.throws(() => inspectPe(unsupported), /DIR64/u);
});
test("changed original bytes cannot reuse upstream provenance", () => {
  const input = fixture(),
    pin = { bytes: input.length, sha256: sha(input), flags: 0 };
  input[530] ^= 1;
  assert.throws(() => deriveImage(input, pin), /immutable/u);
});
test("incorrect preexisting checksum cannot be carried into a derivation", () => {
  const input = fixture();
  input.writeUInt32LE(1, 216);
  assert.throws(() => deriveImage(input, { bytes: input.length, sha256: sha(input), flags: 0 }));
});
