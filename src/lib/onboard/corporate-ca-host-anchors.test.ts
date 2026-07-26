// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BAD_PEM,
  expectWarning,
  LEAF_PEM,
  PEM,
  tmpDir,
  writeAnchor,
  writeCa,
} from "./__test-helpers__/corporate-ca-fixtures";
import {
  CORPORATE_CA_ANCHOR_DIRS_ENV,
  CORPORATE_CA_DISABLE_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CORPORATE_CA_HOST_ANCHOR_DIRS,
  CORPORATE_CA_HOST_ANCHOR_SOURCE,
  CORPORATE_CA_LITERAL_SSL_CERTS_DIR,
  CORPORATE_CA_LITERAL_SSL_CERTS_SOURCE,
  isKnownMergedTrustStorePath,
  MAX_CORPORATE_CA_CERTS,
  resolveCorporateCa,
  resolveCorporateCaFromHostAnchors,
} from "./corporate-ca";

function writeManyAnchors(dir: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    writeAnchor(dir, `corp-${String(i).padStart(3, "0")}.crt`, PEM);
  }
}

describe("resolveCorporateCaFromHostAnchors host trust-store path (#6210)", () => {
  it("imports from anchor-source dirs, not merged /etc/ssl/certs output (#6210)", () => {
    expect(CORPORATE_CA_HOST_ANCHOR_DIRS).toContain("/usr/local/share/ca-certificates");
    expect(CORPORATE_CA_HOST_ANCHOR_DIRS).not.toContain("/etc/ssl/certs");
    expect(CORPORATE_CA_HOST_ANCHOR_DIRS).not.toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(CORPORATE_CA_LITERAL_SSL_CERTS_DIR).toBe("/etc/ssl/certs");
    expect(isKnownMergedTrustStorePath("/etc/ssl/certs/ca-certificates.crt")).toBe(true);
  });

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
    expectWarning(messages, anchorDir, "WARNING");
  });

  it("warns and skips when anchor candidate files exceed the scan cap", () => {
    const anchorDir = tmpDir();
    writeManyAnchors(anchorDir, 257);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromHostAnchors([anchorDir]);
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved).toBeNull();
    expectWarning(messages, anchorDir, "exceeds scan caps", "truncated trust import");
  });

  it("warns and skips when anchor directory traversal exceeds the scan cap", () => {
    const anchorDir = tmpDir();
    for (let i = 0; i < 1025; i += 1) {
      fs.mkdirSync(path.join(anchorDir, `d-${String(i).padStart(4, "0")}`));
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromHostAnchors([anchorDir]);
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved).toBeNull();
    expectWarning(messages, anchorDir, "exceeds scan caps", "truncated trust import");
  });

  it("discovers a corporate root nested in an anchor subdirectory", () => {
    const anchorDir = tmpDir();
    const sub = path.join(anchorDir, "acme");
    fs.mkdirSync(sub);
    writeAnchor(sub, "root.crt");
    expect(resolveCorporateCaFromHostAnchors([anchorDir])?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("skips symlinked anchor entries", () => {
    const realCert = writeCa(tmpDir());
    const anchorDir = tmpDir();
    fs.symlinkSync(realCert, path.join(anchorDir, "linked.crt"));
    expect(resolveCorporateCaFromHostAnchors([anchorDir])).toBeNull();
  });

  it("skips an unreadable anchor directory without throwing", () => {
    const anchorDir = tmpDir();
    fs.chmodSync(anchorDir, 0o000);
    expect(() => resolveCorporateCaFromHostAnchors([anchorDir])).not.toThrow();
    expect(resolveCorporateCaFromHostAnchors([anchorDir])).toBeNull();
    fs.chmodSync(anchorDir, 0o700);
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
    expect(
      resolveCorporateCa(
        {},
        { hostAnchorDirs: [path.join(tmpDir(), "absent")], literalSslCertsDir: null },
      ),
    ).toBeNull();
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

  it("imports a standalone CA from a literal /etc/ssl/certs-style directory (#6210)", () => {
    const literalSslCertsDir = tmpDir();
    writeAnchor(literalSslCertsDir, "ca-certificates.crt");
    writeAnchor(literalSslCertsDir, "ssl-cert-snakeoil.pem", LEAF_PEM);
    writeAnchor(literalSslCertsDir, "corp-proxy-root.pem");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCa(
      {},
      { hostAnchorDirs: [path.join(tmpDir(), "absent")], literalSslCertsDir },
    );
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_LITERAL_SSL_CERTS_SOURCE);
    expect(resolved?.sourcePath).toBe(literalSslCertsDir);
    expect(resolved?.pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    expect(messages).toHaveLength(0);
  });

  it("does not warn for a literal /etc/ssl/certs-style leaf cert such as ssl-cert-snakeoil.pem", () => {
    const literalSslCertsDir = tmpDir();
    writeAnchor(literalSslCertsDir, "ssl-cert-snakeoil.pem", LEAF_PEM);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCa(
      {},
      { hostAnchorDirs: [path.join(tmpDir(), "absent")], literalSslCertsDir },
    );
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    expect(resolved).toBeNull();
    expect(messages).toHaveLength(0);
  });

  it("does not warn for the merged /etc/ssl/certs ca-certificates output alone (#6210)", () => {
    const literalSslCertsDir = tmpDir();
    writeAnchor(literalSslCertsDir, "ca-certificates.crt");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCa(
      {},
      { hostAnchorDirs: [path.join(tmpDir(), "absent")], literalSslCertsDir },
    );
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    expect(resolved).toBeNull();
    expect(messages).toHaveLength(0);
  });

  it("warns and skips overlarge literal /etc/ssl/certs-style candidate sets", () => {
    const literalSslCertsDir = tmpDir();
    writeManyAnchors(literalSslCertsDir, 257);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCa(
      {},
      { hostAnchorDirs: [path.join(tmpDir(), "absent")], literalSslCertsDir },
    );
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    expect(resolved).toBeNull();
    expectWarning(messages, "/etc/ssl/certs", "more than 256", "truncated trust import");
  });

  it("does not warn about literal /etc/ssl/certs when host-store scanning is disabled", () => {
    const literalSslCertsDir = tmpDir();
    writeAnchor(literalSslCertsDir, "corp-proxy-root.pem");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCa(
      { [CORPORATE_CA_ANCHOR_DIRS_ENV]: "" },
      { literalSslCertsDir },
    );
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    expect(resolved).toBeNull();
    expect(messages).toHaveLength(0);
  });
});
