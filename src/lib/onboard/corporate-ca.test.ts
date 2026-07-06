// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CORPORATE_CA_DISABLE_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CorporateCaValidationError,
  encodeCorporateCaArg,
  MAX_CORPORATE_CA_BYTES,
  resolveCorporateCaFromEnv,
  validateCorporateCaFile,
} from "./corporate-ca";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeCa(dir: string, contents = PEM, mode = 0o644): string {
  const p = path.join(dir, "corp-ca.pem");
  fs.writeFileSync(p, contents, { mode });
  fs.chmodSync(p, mode);
  return p;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(() => validateCorporateCaFile(p)).toThrow(/world-writable/);
  });

  it("rejects a file without a PEM certificate block", () => {
    const p = writeCa(tmpDir(), "not a certificate\n");
    expect(() => validateCorporateCaFile(p)).toThrow(/no PEM CERTIFICATE block/);
  });
});

describe("resolveCorporateCaFromEnv", () => {
  it("returns null when no CA env is set", () => {
    expect(resolveCorporateCaFromEnv({})).toBeNull();
  });

  it("resolves the explicit env var first", () => {
    const p = writeCa(tmpDir());
    const resolved = resolveCorporateCaFromEnv({ [CORPORATE_CA_EXPLICIT_ENV]: p });
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_EXPLICIT_ENV);
    expect(resolved?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("throws when the explicit env var points at an invalid file", () => {
    expect(() =>
      resolveCorporateCaFromEnv({ [CORPORATE_CA_EXPLICIT_ENV]: "/does/not/exist.pem" }),
    ).toThrow(CorporateCaValidationError);
  });

  it("falls back to REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE", () => {
    const p = writeCa(tmpDir());
    expect(resolveCorporateCaFromEnv({ REQUESTS_CA_BUNDLE: p })?.sourceEnv).toBe(
      "REQUESTS_CA_BUNDLE",
    );
    expect(resolveCorporateCaFromEnv({ CURL_CA_BUNDLE: p })?.sourceEnv).toBe("CURL_CA_BUNDLE");
  });

  it("skips an invalid fallback env var silently and tries the next", () => {
    const p = writeCa(tmpDir());
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/does/not/exist.pem",
      CURL_CA_BUNDLE: p,
    });
    expect(resolved?.sourceEnv).toBe("CURL_CA_BUNDLE");
  });

  it("returns null when every fallback env var is invalid", () => {
    expect(
      resolveCorporateCaFromEnv({ REQUESTS_CA_BUNDLE: "/missing.pem", SSL_CERT_FILE: "/nope.pem" }),
    ).toBeNull();
  });

  it("honors the disable opt-out", () => {
    const p = writeCa(tmpDir());
    expect(
      resolveCorporateCaFromEnv({
        [CORPORATE_CA_EXPLICIT_ENV]: p,
        [CORPORATE_CA_DISABLE_ENV]: "0",
      }),
    ).toBeNull();
  });
});

describe("encodeCorporateCaArg", () => {
  it("produces single-line base64 that round-trips", () => {
    const encoded = encodeCorporateCaArg(PEM);
    expect(encoded).not.toMatch(/[\r\n]/);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(PEM);
  });
});
