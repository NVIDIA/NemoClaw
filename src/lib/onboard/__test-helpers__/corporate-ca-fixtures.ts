// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect } from "vitest";

// A real (self-signed) X.509 certificate so the structural validation accepts
// it; the shape-only fixture (BAD_PEM) is used for negative structural cases.
export const PEM = `-----BEGIN CERTIFICATE-----
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

// A valid self-signed X.509 leaf with Basic Constraints CA:FALSE, matching the
// normal Ubuntu ssl-cert-snakeoil.pem shape that must not be treated as a CA.
export const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDGDCCAgCgAwIBAgIUBGGtRhzw0XS0RsxOgfTf7Q5hi78wDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSTmVtb0NsYXcgVGVzdCBMZWFmMB4XDTI2MDcwOTIxMzA0
OFoXDTM2MDcwNjIxMzA0OFowHTEbMBkGA1UEAwwSTmVtb0NsYXcgVGVzdCBMZWFm
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoDrg6PHhyTdrLLQ4+9EX
Icw9eTXAzMVYlr5621HD8fZO/R+asZB1xzfUCYLQ1ubeDBShXhr/sJDJDNxmOwCY
veU2IfKp2UQ3GBe6uzzUVq5icxXIr7OxR4ynnma4WRKyJR2dTX6QXHh+Oa04Wra8
KR7U9TLvYDHvQtt5i8mVmz28n8jWdVWYKVMPc13Tc40hVennMO4c2bhfdlX1p0l+
c1gscXJC+rVT9E1/U6zlDkPqmTy3M0aM6XDRLcYNXau7fX3ZukyQJJAR19hVaTcP
AzficNDa4/LEX3FkgioDSXyB5vhaL1lnFRAU6+yBz/jfRJmr9FdkKSpHq1NDBXKf
RwIDAQABo1AwTjAdBgNVHQ4EFgQUz5G5tVuiteFQjqBpJ9VVjktmeu0wHwYDVR0j
BBgwFoAUz5G5tVuiteFQjqBpJ9VVjktmeu0wDAYDVR0TAQH/BAIwADANBgkqhkiG
9w0BAQsFAAOCAQEAmfGOHg4dUJES4WXq/DAz1jiV5sPq+EhTAlrnuQpS13fprfYw
T8lPVM4n56WhDnqyy3/5NHywioYwi51EuIIG4Vl11xj2lVZdjPr0k0qWeMGMVmrL
4WArhisGTMC7mnYrNqijPImlwaEWmH3sO5Nhsu8qs3NH3RrX5VYDbxEbnH8YiNkf
/4gq/sCMf22vDoumDdXJQRrYAQPLSgtbxwQzT1nVvLMNjIwO6Vh7qJv4jGt+hCME
UPilgF7+CJ39Hd/NO+iZAvPuS470eWcdGK8i+akGqRIwHqlOSPeJsnLNKFFS/9tO
90WmoSeA7GUsGkJLLoiaBAq8wTdNqbYodVmEBA==
-----END CERTIFICATE-----
`;

// PEM-shaped but not a parseable certificate.
export const BAD_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

// A private-key block that must never survive into the returned/baked bundle.
// Markers are assembled at runtime so the fixture is not itself flagged as a
// committed private key by the secret scanners.
const KEY_LABEL = `${"PRIVATE"} KEY`;
export const PRIVATE_KEY = `-----BEGIN ${KEY_LABEL}-----
MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA3+SuP4mGqjr9Vd0F
super-secret-key-material-that-must-not-be-baked-into-the-image
-----END ${KEY_LABEL}-----
`;

const tmpRoots: string[] = [];

export function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-test-"));
  tmpRoots.push(dir);
  return dir;
}

export function writeCa(dir: string, contents = PEM, mode = 0o644): string {
  const p = path.join(dir, "corp-ca.pem");
  fs.writeFileSync(p, contents, { mode });
  fs.chmodSync(p, mode);
  return p;
}

export function writeAnchor(dir: string, name: string, contents = PEM, mode = 0o644): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents, { mode });
  fs.chmodSync(p, mode);
  return p;
}

export function expectWarning(messages: readonly string[], ...needles: readonly string[]): void {
  expect(messages.some((message) => needles.every((needle) => message.includes(needle)))).toBe(
    true,
  );
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
