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
  MAX_CORPORATE_CA_CERTS,
  resolveCorporateCaFromEnv,
  validateCorporateCaFile,
} from "./corporate-ca";

// A real (self-signed) X.509 certificate so the structural validation accepts
// it; the shape-only fixture (BAD_PEM) is used for negative structural cases.
const PEM = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUL3YNpyohvjOEzlwisLKfyiU3dRwwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaTmVtb0NsYXcgVGVzdCBDb3Jwb3JhdGUgQ0EwHhcNMjYw
NzA2MDQwMjM2WhcNMzYwNzAzMDQwMjM2WjAlMSMwIQYDVQQDDBpOZW1vQ2xhdyBU
ZXN0IENvcnBvcmF0ZSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALVbV5tyMc65jEH39ejvQvBk7dvI8rz8rSZl+5BWSK2a4TzKm3jD3U+qCDZPicrA
ETCDcO09bN6YIAgpB6rYg5BIURJWxFuljBIBMCZEdO6AVlbURPaGsw6RKLA3cmhx
ZekT0qMcoOKm3N+Hb5MHXsWZ8EUf0co2LsWwJgDZrdwY26gF6w+9wr3iGLE92ZbO
LHhjHUYR1oWXmkXS3YW8MN2h5I+oyL71jBiwLHUi59wogxA/LTAD97/GqwJ6DC4C
UERbIpGYhZfrbiKmT+ASJuKRXaUp/0My3IzH90RqqY70d1E/pkAsd5M8SQ332qAZ
OgW4GgO3n7gAlaN/ILwunZ8CAwEAAaNTMFEwHQYDVR0OBBYEFMa5M8bvDm85eFQi
1D5fNATE/rawMB8GA1UdIwQYMBaAFMa5M8bvDm85eFQi1D5fNATE/rawMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8NR/0HBUH1WbbDOmGNDzge
o+4Pz0KWR5fPDSx9CrmvUk8ijKpJQcSjQcmrXuhCoRs6aExXLh+wImKkOyMIVXfd
YFWjCffSJzeBQfDlMVW+wiAjUh7xaIqpA6Z8EmpdfyoNWd30AuHjs9m8dAa8M/lP
0qhzCbjDiHNHfYSrAuBHlMJ5RsUrNVtSZGpg1dtaSBa+8XFWWNBeJrUANxb8i7Ax
MAhrfNQcxSkZH2lVY+TA2JO83v12nKXzaW1dC94SlsFf0tVSvM3QTeWVgijpr0q+
J0N7VBg2CdK6jRjKLQOSOPq3ySCicHhVRI8hxIWotif7mK3jj6D8NRalwmlHgNM=
-----END CERTIFICATE-----
`;
// PEM-shaped but not a parseable certificate.
const BAD_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
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
});

describe("resolveCorporateCaFromEnv", () => {
  it("returns null when no CA env is set", () => {
    expect(resolveCorporateCaFromEnv({})).toBeNull();
  });

  it("does not auto-scan the host trust store, honoring only env-configured sources (#6210)", () => {
    // A corporate CA present only in a host /etc/ssl/certs/-style location must
    // not be auto-discovered. #6210 is intentionally narrowed to the explicit
    // bundle plus REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE/SSL_CERT_FILE fallbacks;
    // scanning the host store would bake broad, unrelated OS trust into the
    // image. The same file resolves only when a var points at it, proving the
    // null is the no-auto-scan contract and not an invalid fixture.
    const hostStore = tmpDir();
    const hostCa = writeCa(hostStore);
    expect(resolveCorporateCaFromEnv({})).toBeNull();
    expect(resolveCorporateCaFromEnv({ [CORPORATE_CA_EXPLICIT_ENV]: hostCa })?.sourcePath).toBe(
      hostCa,
    );
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
