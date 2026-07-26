// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BAD_PEM,
  LEAF_PEM,
  PEM,
  PRIVATE_KEY,
  tmpDir,
  writeCa,
} from "./__test-helpers__/corporate-ca-fixtures";
import {
  CorporateCaValidationError,
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
  validateCorporateCaFile,
} from "./corporate-ca";

describe("validateCorporateCaFile", () => {
  it("returns PEM text for a valid regular file", () => {
    const p = writeCa(tmpDir());
    expect(validateCorporateCaFile(p)).toContain("BEGIN CERTIFICATE");
  });

  it("rejects a missing file", () => {
    expect(() => validateCorporateCaFile(path.join(tmpDir(), "nope.pem"))).toThrow(
      CorporateCaValidationError,
    );
  });

  it("rejects a symlink", () => {
    const dir = tmpDir();
    const real = writeCa(dir);
    const link = path.join(dir, "link.pem");
    fs.symlinkSync(real, link);
    expect(() => validateCorporateCaFile(link)).toThrow(/must not be a symlink/);
  });

  it("rejects a directory", () => {
    expect(() => validateCorporateCaFile(tmpDir())).toThrow(/not a regular file/);
  });

  it("rejects an empty file", () => {
    const p = writeCa(tmpDir(), "");
    expect(() => validateCorporateCaFile(p)).toThrow(/is empty/);
  });

  it("rejects an oversized file", () => {
    const p = writeCa(tmpDir(), `${PEM}${"A".repeat(MAX_CORPORATE_CA_BYTES)}`);
    expect(() => validateCorporateCaFile(p)).toThrow(/exceeds/);
  });

  it("rejects a world-writable file", () => {
    const p = writeCa(tmpDir(), PEM, 0o666);
    expect(() => validateCorporateCaFile(p)).toThrow(/group- or world-writable/);
  });

  it("rejects a group-writable file", () => {
    const p = writeCa(tmpDir(), PEM, 0o664);
    expect(() => validateCorporateCaFile(p)).toThrow(/group- or world-writable/);
  });

  it("rejects a file without a PEM certificate block", () => {
    const p = writeCa(tmpDir(), "not a certificate\n");
    expect(() => validateCorporateCaFile(p)).toThrow(/no PEM CERTIFICATE block/);
  });

  it("rejects a bundle with more than the certificate cap", () => {
    const p = writeCa(tmpDir(), PEM.repeat(MAX_CORPORATE_CA_CERTS + 1));
    expect(() => validateCorporateCaFile(p)).toThrow(/certificates \(max/);
  });

  it("rejects a PEM-shaped block that is not a parseable X.509 certificate", () => {
    const p = writeCa(tmpDir(), BAD_PEM);
    expect(() => validateCorporateCaFile(p)).toThrow(/not a valid X\.509 certificate/);
  });

  it("rejects a bundle whose later block is not a parseable X.509 certificate", () => {
    const p = writeCa(tmpDir(), PEM + BAD_PEM);
    expect(() => validateCorporateCaFile(p)).toThrow(/not a valid X\.509 certificate/);
  });

  it("rejects a valid X.509 leaf certificate without CA basic constraints", () => {
    const p = writeCa(tmpDir(), LEAF_PEM);
    expect(() => validateCorporateCaFile(p)).toThrow(/not a CA/);
  });

  it("rejects a bundle whose later block is a leaf certificate", () => {
    const p = writeCa(tmpDir(), PEM + LEAF_PEM);
    expect(() => validateCorporateCaFile(p)).toThrow(/not a CA/);
  });

  it("returns only the certificate block, dropping an adjacent private key", () => {
    const p = writeCa(tmpDir(), `${PEM}\n${PRIVATE_KEY}`);
    const result = validateCorporateCaFile(p);
    expect(result).toContain("BEGIN CERTIFICATE");
    expect(result).not.toContain("PRIVATE KEY");
    expect(result).not.toContain("super-secret-key-material");
  });

  it("drops arbitrary non-certificate text surrounding the certificate", () => {
    const p = writeCa(tmpDir(), `# corp bundle exported 2026\n${PEM}\ntrailing secret note\n`);
    const result = validateCorporateCaFile(p);
    expect(result).toContain("BEGIN CERTIFICATE");
    expect(result).not.toContain("corp bundle exported");
    expect(result).not.toContain("trailing secret note");
  });

  it("returns a normalized bundle of exactly the validated certificate blocks", () => {
    const p = writeCa(tmpDir(), `\n\n${PEM}\n${PEM}\n\n`);
    const result = validateCorporateCaFile(p);
    const blocks = result.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect(result.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    expect(result.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
  });
});
