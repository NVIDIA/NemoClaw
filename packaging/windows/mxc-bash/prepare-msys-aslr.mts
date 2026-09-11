// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-derived metadata experiment. These output files are not untouched upstream artifacts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CertificatePin = { offset: number; bytes: number; sha256: string };
type ImagePin = { bytes: number; sha256: string; flags: number; certificate?: CertificatePin };
export const originals: Record<string, ImagePin> = {
  "usr/bin/msys-2.0.dll": {
    bytes: 3364447,
    sha256: "13f0b0dc94588766ecfa1867f1a00061508ba1dc62f5b8e858ac59f01e358aa0",
    flags: 0,
  },
  "usr/bin/bash.exe": {
    bytes: 2455808,
    sha256: "92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474",
    flags: 0x8000,
    certificate: {
      offset: 2442752,
      bytes: 13056,
      sha256: "ad13eb3d0e085570befdca351ea777c89bce3120f9675b2c5e8ba3df9a674e5d",
    },
  },
};
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export function inspectPe(data: Buffer, certificate?: CertificatePin) {
  assert(data.length >= 512 && data.length < 64 * 1024 * 1024);
  assert.equal(data.readUInt16LE(0), 0x5a4d);
  const pe = data.readUInt32LE(60);
  assert(pe >= 64 && pe + 264 <= data.length);
  assert.equal(data.readUInt32LE(pe), 0x4550);
  assert.equal(data.readUInt16LE(pe + 4), 0x8664, "Only the pinned x64 images are selected");
  assert.equal(data.readUInt16LE(pe + 22) & 1, 0, "Relocations must not be stripped");
  const count = data.readUInt16LE(pe + 6),
    optionalBytes = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  assert(count > 0 && count <= 32 && optionalBytes >= 240);
  assert.equal(data.readUInt16LE(optional), 0x20b);
  assert(data.readUInt32LE(optional + 108) >= 6);
  const certificateDirectoryOffset = optional + 112 + 32;
  const certificateOffset = data.readUInt32LE(certificateDirectoryOffset);
  const certificateBytes = data.readUInt32LE(certificateDirectoryOffset + 4);
  if (certificate) {
    assert.equal(certificateOffset, certificate.offset);
    assert.equal(certificateBytes, certificate.bytes);
    assert(certificateOffset % 8 === 0 && certificateBytes >= 8);
    assert.equal(
      certificateOffset + certificateBytes,
      data.length,
      "Only an exact trailing certificate may be removed",
    );
    assert.equal(
      data.readUInt32LE(certificateOffset),
      certificateBytes,
      "Expected one complete WIN_CERTIFICATE",
    );
    assert.equal(data.readUInt16LE(certificateOffset + 4), 0x200);
    assert.equal(data.readUInt16LE(certificateOffset + 6), 2);
    assert.equal(
      hash(data.subarray(certificateOffset)),
      certificate.sha256,
      "Original certificate bytes changed",
    );
  } else {
    assert.equal(certificateOffset, 0, "Signed images require the exact certificate-removal pin");
    assert.equal(certificateBytes, 0, "Certificate directory must be empty");
  }
  const table = optional + optionalBytes;
  assert(table + count * 40 <= data.length);
  const imageSize = data.readUInt32LE(optional + 56),
    headersSize = data.readUInt32LE(optional + 60);
  if (certificate) assert(certificateOffset >= headersSize);
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 40;
    const rva = data.readUInt32LE(at + 12),
      bytes = data.readUInt32LE(at + 16),
      offset = data.readUInt32LE(at + 20);
    assert(rva < imageSize);
    if (bytes) assert(offset >= headersSize && offset + bytes <= data.length);
    if (certificate && bytes)
      assert(offset + bytes <= certificateOffset, "Certificate must not overlap any section");
    sections.push({
      name: data
        .subarray(at, at + 8)
        .toString("ascii")
        .replace(/\0.*$/u, ""),
      rva,
      virtualBytes: data.readUInt32LE(at + 8),
      bytes,
      offset,
      sha256: hash(data.subarray(offset, offset + bytes)),
    });
  }
  const relocationRva = data.readUInt32LE(optional + 112 + 40),
    relocationBytes = data.readUInt32LE(optional + 112 + 44);
  assert(relocationRva > 0 && relocationBytes >= 8);
  const candidates = sections.filter(
    (s) => s.rva <= relocationRva && relocationRva + relocationBytes <= s.rva + s.bytes,
  );
  assert.equal(
    candidates.length,
    1,
    "Relocation directory must fit exactly one file-backed section",
  );
  let cursor = candidates[0]!.offset + relocationRva - candidates[0]!.rva;
  const end = cursor + relocationBytes;
  let relocations = 0;
  while (cursor < end) {
    assert(cursor + 8 <= end);
    const page = data.readUInt32LE(cursor),
      bytes = data.readUInt32LE(cursor + 4);
    assert(page % 4096 === 0 && bytes >= 8 && bytes % 2 === 0 && cursor + bytes <= end);
    for (let at = cursor + 8; at < cursor + bytes; at += 2) {
      const entry = data.readUInt16LE(at),
        kind = entry >>> 12;
      assert(kind === 0 || kind === 10, "Only ABSOLUTE padding and DIR64 relocations are expected");
      if (kind === 10) {
        assert(page + (entry & 0xfff) + 8 <= imageSize);
        relocations++;
      }
    }
    cursor += bytes;
  }
  assert(relocations > 0);
  return {
    flagsOffset: optional + 70,
    checksumOffset: optional + 64,
    flags: data.readUInt16LE(optional + 70),
    checksum: data.readUInt32LE(optional + 64),
    imageBase: "0x" + data.readBigUInt64LE(optional + 24).toString(16),
    imageSize,
    entryPointRva: data.readUInt32LE(optional + 16),
    certificateDirectoryOffset,
    certificate: certificate ? { ...certificate, recordRevision: 0x200, recordType: 2 } : null,
    relocationRva,
    relocationBytes,
    relocations,
    sections,
  };
}

export function imageChecksum(data: Buffer, checksumOffset: number) {
  let sum = 0;
  for (let at = 0; at < data.length; at += 2) {
    if (at >= checksumOffset && at < checksumOffset + 4) continue;
    sum += data[at]! + ((data[at + 1] ?? 0) << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + data.length) >>> 0;
}

export function deriveImage(input: Buffer, pin: ImagePin) {
  assert.equal(input.length, pin.bytes);
  assert.equal(hash(input), pin.sha256, "Upstream bytes must match the immutable input");
  const before = inspectPe(input, pin.certificate);
  assert.equal(before.flags, pin.flags);
  assert.equal(before.flags & 0x40, 0, "Input must be the preserved original");
  assert.equal(imageChecksum(input, before.checksumOffset), before.checksum);
  const output = Buffer.from(input.subarray(0, pin.certificate?.offset ?? input.length));
  if (pin.certificate)
    output.fill(0, before.certificateDirectoryOffset, before.certificateDirectoryOffset + 8);
  output.writeUInt16LE(before.flags | 0x40, before.flagsOffset);
  output.writeUInt32LE(imageChecksum(output, before.checksumOffset), before.checksumOffset);
  const after = inspectPe(output);
  assert.deepEqual(
    after.sections,
    before.sections,
    "All code/data/relocation sections must remain byte-identical",
  );
  const restored = Buffer.from(output);
  input.copy(restored, before.flagsOffset, before.flagsOffset, before.flagsOffset + 2);
  input.copy(restored, before.checksumOffset, before.checksumOffset, before.checksumOffset + 4);
  input.copy(
    restored,
    before.certificateDirectoryOffset,
    before.certificateDirectoryOffset,
    before.certificateDirectoryOffset + 8,
  );
  assert(
    restored.equals(input.subarray(0, output.length)),
    "Only loader metadata and the exact trailing certificate may differ",
  );
  return {
    output,
    receipt: {
      beforeSha256: pin.sha256,
      afterSha256: hash(output),
      beforeBytes: input.length,
      bytes: output.length,
      beforeFlags: before.flags,
      afterFlags: after.flags,
      flagsOffset: before.flagsOffset,
      beforeChecksum: before.checksum,
      afterChecksum: after.checksum,
      checksumOffset: before.checksumOffset,
      imageBase: before.imageBase,
      entryPointRva: before.entryPointRva,
      relocations: before.relocations,
      relocationRva: before.relocationRva,
      relocationBytes: before.relocationBytes,
      certificateDirectoryAbsent: true,
      certificateDirectoryOffset: before.certificateDirectoryOffset,
      originalCertificate: before.certificate
        ? { ...before.certificate, authenticodeStatus: "pending-native-verification" }
        : null,
      certificateTableRemoved: Boolean(before.certificate),
      derivedNotSigned: true,
      onlyMetadataChanged: true,
      sections: before.sections,
    },
  };
}

function inventory(root: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name),
        stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), "A derived runtime cannot follow filesystem links");
      if (stat.isDirectory()) visit(absolute);
      else {
        assert(stat.isFile() && stat.nlink === 1 && stat.size <= 128 * 1024 * 1024);
        files.push({
          path: path.relative(root, absolute).replaceAll("\\", "/"),
          bytes: stat.size,
          sha256: hash(fs.readFileSync(absolute)),
        });
        assert(files.length <= 20000);
      }
    }
  }
  visit(root);
  return files;
}

function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const argument = (name: string) => {
    const at = process.argv.indexOf(name);
    assert(at >= 0 && process.argv[at + 1]);
    return path.resolve(process.argv[at + 1]!);
  };
  const source = argument("--source"),
    destination = argument("--destination"),
    evidence = argument("--evidence");
  assert.equal(path.basename(source), "git-original");
  assert.equal(path.basename(destination), "git");
  assert.equal(path.dirname(source), path.dirname(destination));
  assert.match(path.dirname(source), /^[A-Za-z]:\\NemoClawMsysProof-[a-f0-9]{12}$/u);
  assert(!fs.existsSync(destination) && !fs.existsSync(evidence));
  const before = inventory(source);
  for (const [relative, expected] of Object.entries({
    "usr/bin/bash.exe": "92cff5f145d42f85b55aa3be8d3ad9827844a21ec4fbeaa1ddfe1dd4d76c6474",
    "bin/bash.exe": "828e6e891cee98d39057c0c193800e564231fdf92b3cefa15944378fc7730095",
  }))
    assert.equal(hash(fs.readFileSync(path.join(source, relative))), expected);
  fs.mkdirSync(evidence, { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  assert.deepEqual(inventory(destination), before);
  const files: ({ path: string } & ReturnType<typeof deriveImage>["receipt"])[] = [];
  fs.copyFileSync(
    path.join(source, "bin/bash.exe"),
    path.join(evidence, "original-arm64-wrapper.exe"),
    fs.constants.COPYFILE_EXCL,
  );
  for (const [relative, pin] of Object.entries(originals)) {
    const input = fs.readFileSync(path.join(source, relative));
    const { output, receipt } = deriveImage(input, pin);
    fs.writeFileSync(path.join(evidence, "original-" + path.basename(relative)), input, {
      flag: "wx",
    });
    fs.writeFileSync(path.join(evidence, "derived-" + path.basename(relative)), output, {
      flag: "wx",
    });
    if (pin.certificate)
      fs.writeFileSync(
        path.join(evidence, "original-bash-certificate.bin"),
        input.subarray(pin.certificate.offset),
        { flag: "wx" },
      );
    fs.writeFileSync(path.join(destination, relative), output);
    files.push({ path: relative, ...receipt });
  }
  const after = inventory(destination);
  assert.deepEqual(inventory(source), before, "Preserved upstream tree changed");
  assert.deepEqual(
    after,
    before.map((row) => {
      const change = files.find((f) => f.path === row.path);
      return change ? { ...row, bytes: change.bytes, sha256: change.afterSha256 } : row;
    }),
  );
  fs.writeFileSync(
    path.join(evidence, "derivation.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "ci-derived-canonical-msys-dynamic-base",
        sourceRevision: process.env.GITHUB_SHA,
        upstream: {
          nousCommit: "2237be355906fbe6065ce1815711eee52b2d646e",
          portableGitVersion: "2.54.0.windows.1",
          url: "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-arm64.7z.exe",
          sha256: "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7",
        },
        untouchedOfficialBytes: false,
        originalsPreserved: true,
        allOtherFilesUnchanged: true,
        adaptation: "msys-dll-and-unsigned-bash-dynamic-base",
        arm64WrapperUnchanged: true,
        derivedBashExplicitlyUnsigned: true,
        fileCount: before.length,
        originalInventorySha256: hash(Buffer.from(JSON.stringify(before))),
        derivedInventorySha256: hash(Buffer.from(JSON.stringify(after))),
        files,
        nativeChecksumVerificationRequired: true,
        nativeAuthenticodeVerificationRequired: true,
        qualified: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
