// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Validates the malformed-input guards on the corporate-proxy CA base64 decode
// RUN step in both agent Dockerfiles (#6210). Runs the actual shipped RUN block,
// not a re-implementation, against invalid base64, valid-but-not-a-certificate,
// and a real certificate.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasGnuBase64Decode,
  hasOpenssl,
  runDockerfileCorporateCaDecode,
} from "./helpers/corporate-ca-support";

// The extracted RUN block uses GNU `base64 --decode` (rejected by BSD/macOS
// `base64`) and requires the `openssl` CLI to validate the bundle. The sandbox
// image is only ever built on Linux with both present, so skip this shipped-
// shell check on hosts lacking either (e.g. the macOS Vitest job).
const canRunDecodeBlock = hasGnuBase64Decode() && hasOpenssl();

// A real self-signed X.509 certificate (structural validation accepts it).
const CERT_PEM = `-----BEGIN CERTIFICATE-----
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

const DOCKERFILES = [
  ["OpenClaw", join(import.meta.dirname, "../Dockerfile")],
  ["Hermes", join(import.meta.dirname, "../agents/hermes/Dockerfile")],
] as const;

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-corp-ca-decode-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, dockerfile] of DOCKERFILES) {
  describe.skipIf(!canRunDecodeBlock)(
    `corporate CA Dockerfile decode guard — ${label} (#6210)`,
    () => {
      it("fails with a clear error on invalid base64", () => {
        const res = runDockerfileCorporateCaDecode(dockerfile, "not_valid_base64_@@@", tmpDir());
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("not valid base64");
      });

      it("fails when the decoded content is not a valid certificate", () => {
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from("just some text, not a PEM").toString("base64"),
          tmpDir(),
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("valid X.509 certificates");
      });

      it("fails when the payload is a certificate header wrapping non-certificate bytes", () => {
        const fakePem =
          "-----BEGIN CERTIFICATE-----\nnot a real certificate\n-----END CERTIFICATE-----\n";
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from(fakePem).toString("base64"),
          tmpDir(),
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("valid X.509 certificates");
      });

      it("fails when a later certificate block in the bundle is corrupt", () => {
        const corruptTail =
          "-----BEGIN CERTIFICATE-----\nnot a real certificate\n-----END CERTIFICATE-----\n";
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from(`${CERT_PEM}${corruptTail}`).toString("base64"),
          tmpDir(),
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("valid X.509 certificates");
      });

      it("rejects a PEM that is a certificate request, not a certificate", () => {
        const csr =
          "-----BEGIN CERTIFICATE REQUEST-----\nMIIBnjCCAQcCAQAwXjELMAk=\n-----END CERTIFICATE REQUEST-----\n";
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from(csr).toString("base64"),
          tmpDir(),
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("valid X.509 certificates");
      });

      it("succeeds for a valid base64-encoded certificate", () => {
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from(CERT_PEM).toString("base64"),
          tmpDir(),
        );
        expect(res.status).toBe(0);
      });

      it("strips trailing non-certificate content and bakes only the certificate", () => {
        const dir = tmpDir();
        const withTrailer = `${CERT_PEM}\n# a stray comment\n-----BEGIN CERTIFICATE REQUEST-----\nMIIBnjCCAQc=\n-----END CERTIFICATE REQUEST-----\n`;
        const res = runDockerfileCorporateCaDecode(
          dockerfile,
          Buffer.from(withTrailer).toString("base64"),
          dir,
        );
        expect(res.status).toBe(0);
        const baked = readFileSync(join(dir, "corporate-ca.pem"), "utf-8");
        expect(baked).toContain("-----BEGIN CERTIFICATE-----");
        expect(baked).not.toContain("CERTIFICATE REQUEST");
        expect(baked).not.toContain("stray comment");
      });
    },
  );
}
