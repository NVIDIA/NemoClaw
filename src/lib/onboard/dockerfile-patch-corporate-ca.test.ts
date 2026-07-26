// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Corporate-proxy CA baking in the staged Dockerfile (#6210). Kept in a focused
// file (alongside dockerfile-patch-build-id/-extra-agents/-security) rather than
// growing the dockerfile-patch monolith.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

// A real self-signed X.509 certificate (structural validation rejects garbage).
const CA_PEM = `-----BEGIN CERTIFICATE-----
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

const CA_ENV = [
  "NEMOCLAW_CORPORATE_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
];
const ANCHOR_DIRS_ENV = "NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS";
const tmpRoots: string[] = [];

function clearCaEnv(): void {
  for (const name of CA_ENV) {
    delete process.env[name];
  }
}

// Disable host trust-store scanning so these tests never depend on real host CA
// state (e.g. a corporate dev machine with an installed anchor).
beforeEach(() => {
  clearCaEnv();
  process.env[ANCHOR_DIRS_ENV] = "";
});

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearCaEnv();
  delete process.env[ANCHOR_DIRS_ENV];
});

function writeCa(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-arg-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "corp-ca.pem");
  fs.writeFileSync(file, CA_PEM, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  return file;
}

function dockerfileWith(argLines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-dockerfile-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, argLines.join("\n"), "utf-8");
  return file;
}

const BASE_ARGS = [
  "ARG NEMOCLAW_MODEL=old",
  "ARG NEMOCLAW_PROVIDER_KEY=old",
  "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
  "ARG CHAT_UI_URL=old",
  "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
  "ARG NEMOCLAW_INFERENCE_API=old",
  "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
  "ARG NEMOCLAW_BUILD_ID=old",
  "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
  "ARG NEMOCLAW_PROXY_HOST=old",
  "ARG NEMOCLAW_PROXY_PORT=old",
  "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
  "ARG NEMOCLAW_OPENCLAW_OTEL=0",
  "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
];

function patch(dockerfilePath: string): void {
  patchStagedDockerfile(
    dockerfilePath,
    "custom-model",
    "https://chat.example",
    "build-1",
    "compatible-endpoint",
    null,
    null,
    null,
    false,
    null,
    [],
  );
}

function corporateCaArgLine(dockerfilePath: string): string | undefined {
  return fs
    .readFileSync(dockerfilePath, "utf-8")
    .split("\n")
    .find((entry) => entry.startsWith("ARG NEMOCLAW_CORPORATE_CA_B64="));
}

describe("dockerfile patch — corporate CA baking (#6210)", () => {
  it("bakes an explicit host corporate CA into NEMOCLAW_CORPORATE_CA_B64", () => {
    process.env.NEMOCLAW_CORPORATE_CA_BUNDLE = writeCa();
    const dockerfilePath = dockerfileWith([...BASE_ARGS, "ARG NEMOCLAW_CORPORATE_CA_B64="]);

    patch(dockerfilePath);

    const line = corporateCaArgLine(dockerfilePath);
    assert.ok(line, "expected corporate CA build arg");
    const encoded = line.slice("ARG NEMOCLAW_CORPORATE_CA_B64=".length);
    expect(encoded).not.toBe("");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(CA_PEM);
  });

  it("bakes a fallback REQUESTS_CA_BUNDLE corporate CA", () => {
    process.env.REQUESTS_CA_BUNDLE = writeCa();
    const dockerfilePath = dockerfileWith([...BASE_ARGS, "ARG NEMOCLAW_CORPORATE_CA_B64="]);

    patch(dockerfilePath);

    const line = corporateCaArgLine(dockerfilePath);
    expect(line?.slice("ARG NEMOCLAW_CORPORATE_CA_B64=".length)).not.toBe("");
  });

  it("logs the fallback source env var and path when baking a fallback CA", () => {
    const caPath = writeCa();
    process.env.REQUESTS_CA_BUNDLE = caPath;
    const dockerfilePath = dockerfileWith([...BASE_ARGS, "ARG NEMOCLAW_CORPORATE_CA_B64="]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    patch(dockerfilePath);
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();

    const bakeLog = messages.find((message) => message.includes("corporate proxy CA"));
    expect(bakeLog).toContain("REQUESTS_CA_BUNDLE");
    expect(bakeLog).toContain(caPath);
  });

  it("leaves NEMOCLAW_CORPORATE_CA_B64 empty when no corporate CA is configured", () => {
    const dockerfilePath = dockerfileWith([...BASE_ARGS, "ARG NEMOCLAW_CORPORATE_CA_B64="]);

    patch(dockerfilePath);

    expect(corporateCaArgLine(dockerfilePath)).toBe("ARG NEMOCLAW_CORPORATE_CA_B64=");
  });

  it("fails loudly when an explicit CA is set but the Dockerfile lacks the ARG", () => {
    process.env.NEMOCLAW_CORPORATE_CA_BUNDLE = writeCa();
    const dockerfilePath = dockerfileWith(BASE_ARGS);

    expect(() => patch(dockerfilePath)).toThrow(/missing ARG NEMOCLAW_CORPORATE_CA_B64/);
  });

  it("stays a no-op for a fallback CA when a custom Dockerfile lacks the ARG", () => {
    process.env.CURL_CA_BUNDLE = writeCa();
    const dockerfilePath = dockerfileWith(BASE_ARGS);

    expect(() => patch(dockerfilePath)).not.toThrow();
    expect(corporateCaArgLine(dockerfilePath)).toBeUndefined();
  });
});
