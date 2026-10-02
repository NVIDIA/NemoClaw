// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveImage,
  imageChecksum,
  inspectPe,
  imageEvidenceNames,
  originals,
} from "./prepare-msys-aslr.mts";

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
function signedFixture() {
  const data = Buffer.concat([fixture(), Buffer.alloc(16)]);
  data.writeUInt16LE(0x8000, 222);
  data.writeUInt32LE(1536, 296);
  data.writeUInt32LE(16, 300);
  data.writeUInt32LE(16, 1536);
  data.writeUInt16LE(0x200, 1540);
  data.writeUInt16LE(2, 1542);
  data.writeUInt32LE(imageChecksum(data, 216), 216);
  return data;
}
function signedPin(data: Buffer, offset = 1536, bytes = 16) {
  return {
    bytes: data.length,
    sha256: sha(data),
    flags: 0x8000,
    certificate: { offset, bytes, sha256: sha(data.subarray(offset, offset + bytes)) },
  };
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
test("derived signed-input copy removes only its exact trailing certificate and enables normal ASLR", () => {
  const input = signedFixture(),
    preserved = Buffer.from(input),
    pin = signedPin(input);
  const before = inspectPe(input, pin.certificate);
  const { output, receipt } = deriveImage(input, pin);
  assert(input.equals(preserved));
  assert.equal(output.length, 1536);
  assert.equal(receipt.beforeBytes, 1552);
  assert.equal(receipt.beforeFlags, 0x8000);
  assert.equal(receipt.afterFlags, 0x8040);
  assert.equal(receipt.derivedNotSigned, true);
  assert.equal(receipt.certificateTableRemoved, true);
  assert.equal(receipt.originalCertificate?.sha256, pin.certificate.sha256);
  assert.equal(receipt.originalCertificate?.authenticodeStatus, "pending-native-verification");
  assert.equal(inspectPe(output).certificate, null);
  assert.equal(inspectPe(output).entryPointRva, before.entryPointRva);
  assert.deepEqual(inspectPe(output).sections, before.sections);
  assert.equal(output.readBigUInt64LE(296), 0n);
  assert.equal(imageChecksum(output, 216), receipt.afterChecksum);
  const allowed = new Set([216, 217, 218, 219, 222, 223, 296, 297, 298, 299, 300, 301, 302, 303]);
  for (let i = 0; i < output.length; i++) if (!allowed.has(i)) assert.equal(output[i], input[i]);
});
test("certificate removal refuses non-trailing, overlapping or changed certificate data", () => {
  const trailing = Buffer.concat([signedFixture(), Buffer.alloc(8)]);
  assert.throws(
    () => inspectPe(trailing, signedPin(trailing).certificate),
    /trailing certificate/u,
  );
  const overlapping = fixture();
  overlapping.writeUInt32LE(1408, 296);
  overlapping.writeUInt32LE(128, 300);
  overlapping.writeUInt32LE(128, 1408);
  overlapping.writeUInt16LE(0x200, 1412);
  overlapping.writeUInt16LE(2, 1414);
  assert.throws(
    () => inspectPe(overlapping, signedPin(overlapping, 1408, 128).certificate),
    /overlap/u,
  );
  const changed = signedFixture(),
    pin = signedPin(changed);
  changed[1544] ^= 1;
  assert.throws(() => inspectPe(changed, pin.certificate), /certificate bytes changed/u);
});
test("certificate removal requires the complete single PKCS7 certificate header", () => {
  for (const [offset, value] of [
    [1536, 8],
    [1540, 0x100],
    [1542, 1],
  ]) {
    const data = signedFixture();
    if (offset === 1536) data.writeUInt32LE(value!, offset);
    else data.writeUInt16LE(value!, offset!);
    assert.throws(() => inspectPe(data, signedPin(data).certificate));
  }
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

test("same-byte sh alias is declared separately with collision-free evidence names", () => {
  assert.deepEqual(originals["usr/bin/sh.exe"], originals["usr/bin/bash.exe"]);
  assert.deepEqual(imageEvidenceNames("usr/bin/sh.exe"), {
    original: "original-sh.exe",
    derived: "derived-sh.exe",
    certificate: "original-sh-certificate.bin",
  });
  const names = ["original-arm64-wrapper.exe", "original-arm64-sh-wrapper.exe"];
  for (const [relative, pin] of Object.entries(originals)) {
    const files = imageEvidenceNames(relative);
    names.push(files.original, files.derived);
    if (pin.certificate) names.push(files.certificate);
  }
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 10);
});
