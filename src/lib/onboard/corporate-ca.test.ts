// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CORPORATE_CA_ANCHOR_DIRS_ENV,
  CORPORATE_CA_DISABLE_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CORPORATE_CA_HOST_ANCHOR_SOURCE,
  CorporateCaValidationError,
  encodeCorporateCaArg,
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
  resolveCorporateCa,
  resolveCorporateCaFromEnv,
  resolveCorporateCaFromHostAnchors,
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
// A private-key block that must never survive into the returned/baked bundle.
// Markers are assembled at runtime so the fixture is not itself flagged as a
// committed private key by the secret scanners.
const KEY_LABEL = `${"PRIVATE"} KEY`;
const PRIVATE_KEY = `-----BEGIN ${KEY_LABEL}-----
MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA3+SuP4mGqjr9Vd0F
super-secret-key-material-that-must-not-be-baked-into-the-image
-----END ${KEY_LABEL}-----
`;
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

function writeAnchor(dir: string, name: string, contents = PEM, mode = 0o644): string {
  const p = path.join(dir, name);
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

describe("resolveCorporateCaFromEnv", () => {
  it("returns null when no CA env is set", () => {
    expect(resolveCorporateCaFromEnv({})).toBeNull();
  });

  it("does not read the host trust store from env resolution alone (#6210)", () => {
    // resolveCorporateCaFromEnv is env-only; host anchor discovery lives in
    // resolveCorporateCaFromHostAnchors / resolveCorporateCa.
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

  it("warns and continues past an invalid fallback env var to the next", () => {
    const p = writeCa(tmpDir());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/does/not/exist.pem",
      CURL_CA_BUNDLE: p,
    });
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved?.sourceEnv).toBe("CURL_CA_BUNDLE");
    expect(messages.some((m) => m.includes("REQUESTS_CA_BUNDLE") && m.includes("WARNING"))).toBe(
      true,
    );
  });

  it("returns null and warns when every fallback env var is invalid", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/missing.pem",
      SSL_CERT_FILE: "/nope.pem",
    });
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved).toBeNull();
    expect(messages.filter((m) => m.includes("WARNING"))).toHaveLength(2);
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

describe("resolveCorporateCaFromHostAnchors host trust-store path (#6210)", () => {
  it("discovers a corporate root installed in a host anchor directory", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp-proxy-root.crt");
    const resolved = resolveCorporateCaFromHostAnchors([anchorDir]);
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_HOST_ANCHOR_SOURCE);
    expect(resolved?.sourcePath).toBe(anchorDir);
    expect(resolved?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("returns the first anchor directory that yields a bundle", () => {
    const missing = path.join(tmpDir(), "absent");
    const present = tmpDir();
    writeAnchor(present, "corp.crt");
    expect(resolveCorporateCaFromHostAnchors([missing, present])?.sourcePath).toBe(present);
  });

  it("returns null when no anchor directory exists", () => {
    expect(
      resolveCorporateCaFromHostAnchors([path.join(tmpDir(), "nope"), path.join(tmpDir(), "gone")]),
    ).toBeNull();
  });

  it("ignores non-anchor files and empty directories", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "README.txt", "not a cert\n");
    expect(resolveCorporateCaFromHostAnchors([anchorDir])).toBeNull();
  });

  it("skips a directory whose aggregate exceeds the certificate cap", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "many.crt", PEM.repeat(MAX_CORPORATE_CA_CERTS + 1));
    expect(resolveCorporateCaFromHostAnchors([anchorDir])).toBeNull();
  });

  it("aggregates multiple anchor files into one bundle", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "root-a.crt");
    writeAnchor(anchorDir, "root-b.crt");
    const resolved = resolveCorporateCaFromHostAnchors([anchorDir]);
    expect(resolved?.pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
  });

  it("accepts .pem/.cer anchors in an operator-supplied directory", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp-root.pem");
    expect(resolveCorporateCaFromHostAnchors([anchorDir])?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("warns when an anchor directory has candidate files but no valid CA", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "broken.crt", BAD_PEM);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromHostAnchors([anchorDir]);
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved).toBeNull();
    expect(messages.some((m) => m.includes(anchorDir) && m.includes("WARNING"))).toBe(true);
  });

  it("discovers a corporate root nested in an anchor subdirectory", () => {
    // update-ca-certificates trusts .crt files recursively, e.g.
    // /usr/local/share/ca-certificates/acme/root.crt.
    const anchorDir = tmpDir();
    const sub = path.join(anchorDir, "acme");
    fs.mkdirSync(sub);
    writeAnchor(sub, "root.crt");
    expect(resolveCorporateCaFromHostAnchors([anchorDir])?.pem).toContain("BEGIN CERTIFICATE");
  });
});

describe("resolveCorporateCa env then host anchors (#6210)", () => {
  it("prefers an env-configured CA over the host anchor directory", () => {
    const envCa = writeCa(tmpDir());
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp.crt");
    const resolved = resolveCorporateCa(
      { [CORPORATE_CA_EXPLICIT_ENV]: envCa },
      { hostAnchorDirs: [anchorDir] },
    );
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_EXPLICIT_ENV);
    expect(resolved?.sourcePath).toBe(envCa);
  });

  it("falls back to the host anchor directory when no env var is set", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp.crt");
    const resolved = resolveCorporateCa({}, { hostAnchorDirs: [anchorDir] });
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_HOST_ANCHOR_SOURCE);
  });

  it("honors the disable opt-out even when a host anchor exists", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp.crt");
    expect(
      resolveCorporateCa({ [CORPORATE_CA_DISABLE_ENV]: "0" }, { hostAnchorDirs: [anchorDir] }),
    ).toBeNull();
  });

  it("returns null when neither env nor host anchors provide a CA", () => {
    expect(resolveCorporateCa({}, { hostAnchorDirs: [path.join(tmpDir(), "absent")] })).toBeNull();
  });

  it("reads host anchor directories from the anchor-dirs env override", () => {
    const anchorDir = tmpDir();
    writeAnchor(anchorDir, "corp.crt");
    const resolved = resolveCorporateCa({ [CORPORATE_CA_ANCHOR_DIRS_ENV]: anchorDir });
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_HOST_ANCHOR_SOURCE);
    expect(resolved?.sourcePath).toBe(anchorDir);
  });

  it("disables host-store scanning when the anchor-dirs override is empty", () => {
    expect(resolveCorporateCa({ [CORPORATE_CA_ANCHOR_DIRS_ENV]: "" })).toBeNull();
  });
});

describe("encodeCorporateCaArg", () => {
  it("produces single-line base64 that round-trips", () => {
    const encoded = encodeCorporateCaArg(PEM);
    expect(encoded).not.toMatch(/[\r\n]/);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(PEM);
  });
});
