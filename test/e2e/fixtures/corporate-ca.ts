// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { trustedSandboxShellScript, type TrustedSandboxShellScript } from "./clients/sandbox.ts";

export type CorporateCaFixtureMode = "explicit" | "requests" | "host-anchor";

export interface CorporateCaFixture {
  dir: string;
  env: NodeJS.ProcessEnv;
  file: string;
  mode: CorporateCaFixtureMode;
  sourceLabel: string;
}

const CORPORATE_CA_FIXTURE_PEM = `-----BEGIN CERTIFICATE-----
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

const CORPORATE_CA_CANARY_LINE = "ZekT0qMcoOKm3N+Hb5MHXsWZ8EUf0co2LsWwJgDZrdwY26gF6w+9wr3iGLE92ZbO";

const CORPORATE_CA_FILE_BY_MODE: Record<CorporateCaFixtureMode, string> = {
  explicit: "corporate-ca.pem",
  requests: "corporate-ca.pem",
  "host-anchor": "corporate-ca.crt",
};

const CORPORATE_CA_SOURCE_LABEL_BY_MODE: Record<CorporateCaFixtureMode, string> = {
  explicit: "NEMOCLAW_CORPORATE_CA_BUNDLE",
  requests: "REQUESTS_CA_BUNDLE fallback",
  "host-anchor": "host trust-store anchor override",
};

const CORPORATE_CA_ENV_BY_MODE: Record<
  CorporateCaFixtureMode,
  (file: string, dir: string) => NodeJS.ProcessEnv
> = {
  explicit: (file) => ({ NEMOCLAW_CORPORATE_CA_BUNDLE: file }),
  requests: (file) => ({ REQUESTS_CA_BUNDLE: file }),
  "host-anchor": (_file, dir) => ({ NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS: dir }),
};

const CORPORATE_CA_MERGE_PROBE = trustedSandboxShellScript(`
set -eu
probe_fail() {
  printf 'CORPORATE_CA_PROBE_FAIL:%s\\n' "$1" >&2
  exit 1
}

expect_export() {
  env_name="$1"
  if grep -F "export $env_name=$bundle" "$runtime_env" >/dev/null || \\
    grep -F "export $env_name='$bundle'" "$runtime_env" >/dev/null || \\
    grep -F "export $env_name=\\"$bundle\\"" "$runtime_env" >/dev/null; then
    return 0
  fi
  probe_fail "runtime-env-$env_name"
}

corp='/usr/local/share/nemoclaw/corporate-ca.pem'
bundle='/tmp/nemoclaw-ca-bundle.pem'
runtime_env='/tmp/nemoclaw-proxy-env.sh'

[ -s "$corp" ] || probe_fail missing-corporate-ca
[ -s "$bundle" ] || probe_fail missing-merged-bundle
[ -s "$runtime_env" ] || probe_fail missing-runtime-env
grep -F '${CORPORATE_CA_CANARY_LINE}' "$corp" >/dev/null || probe_fail corporate-canary-missing
grep -F '${CORPORATE_CA_CANARY_LINE}' "$bundle" >/dev/null || probe_fail bundle-canary-missing
set -- $(wc -c < "$corp")
corp_bytes="$1"
set -- $(wc -c < "$bundle")
bundle_bytes="$1"
[ "$bundle_bytes" -gt "$corp_bytes" ] || probe_fail bundle-did-not-preserve-base

for env_name in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO NODE_EXTRA_CA_CERTS; do
  expect_export "$env_name"
done

printf 'corporate CA baked and merged into %s (%s > %s bytes)\\n' "$bundle" "$bundle_bytes" "$corp_bytes"
`);

export function createCorporateCaFixture(
  mode: CorporateCaFixtureMode,
  prefix: string,
): CorporateCaFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, CORPORATE_CA_FILE_BY_MODE[mode]);
  fs.writeFileSync(file, CORPORATE_CA_FIXTURE_PEM, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  return {
    dir,
    env: CORPORATE_CA_ENV_BY_MODE[mode](file, dir),
    file,
    mode,
    sourceLabel: CORPORATE_CA_SOURCE_LABEL_BY_MODE[mode],
  };
}

export function cleanupCorporateCaFixture(fixture: CorporateCaFixture): void {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

export function corporateCaMergeProbeScript(): TrustedSandboxShellScript {
  return CORPORATE_CA_MERGE_PROBE;
}
