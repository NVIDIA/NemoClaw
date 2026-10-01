// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TEST_DOCKER_DRIVER_GATEWAY_CERT_PEM as TEST_CERT_PEM,
  TEST_DOCKER_DRIVER_GATEWAY_KEY_PEM as TEST_KEY_PEM,
  writeDockerDriverGatewayLocalTlsBundle as writeBundle,
} from "./__test-helpers__/docker-driver-gateway-local-tls";
import {
  dockerDriverGatewayLocalTlsBundleIsComplete,
  ensureDockerDriverGatewayLocalTlsBundle,
  getDockerDriverGatewayLocalTlsBundle,
  resolveCompleteDockerDriverGatewayLocalTlsDir,
} from "./docker-driver-gateway-local-tls";
import { PORTABLE_HOST_GATEWAY_IP } from "./experimental/portable-profile";

const TEST_CERT_VALID_AT = new Date("2026-06-27T00:00:00.000Z");
const TEST_CERT_SKEW_BOUNDARY_NOT_YET_VALID_AT = new Date("2026-06-26T20:38:47.000Z");
const TEST_CERT_NOT_YET_VALID_AT = new Date("2026-06-26T20:38:46.000Z");
const TEST_CERT_SKEW_BOUNDARY_EXPIRED_AT = new Date("2036-06-23T20:48:47.000Z");
const TEST_CERT_EXPIRED_AT = new Date("2036-06-23T20:48:48.000Z");

const TEST_CERT_WITHOUT_REQUIRED_SAN_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUHcSxS4dERobRjaJRbfMQoMPf3K8wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNbmVtb2NsYXctdGVzdDAeFw0yNjA2MjYxOTQ5NTRaFw0z
NjA2MjMxOTQ5NTRaMBgxFjAUBgNVBAMMDW5lbW9jbGF3LXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDXwhjS2SOCpElldjSxB/qwXVEnliSKHJIU
1x32jmobOAmaIsJNJ/aMtxTTci4YQcCBGG9RmbGGemzR88HqvJkI0Oed/39dTYgF
zlIRlgJwU4bh+uvU6UjU4+EH9KYOH8SXJtwI0PDUBwzQTksX3/0EtphwtWXZ4KwN
5NkFC+4cqVL875Mc5XtFYHfxqusw3+wfgNpHJtnGsPPNNGaK8CNpsmB1P0oQ88jU
G4G4z40HqaHr2LEh8yTw9TukktbaXtosgNvwuo8Ujq/48ETdyLsSi11aeUGh6l7j
bP5oWyZpqMSSTLsmrBxuGWbEOpduzFNxjuKmoSC+NkLVf9Ucn+EfAgMBAAGjUzBR
MB0GA1UdDgQWBBR0qPxRGOcKDuV8fcjJIZjl0KeWDjAfBgNVHSMEGDAWgBR0qPxR
GOcKDuV8fcjJIZjl0KeWDjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQDXQwNw1y81lJ+A8c7oykoOuZc4JVyUzVZK3XskcqO+rwD32STwUGrK5uN5
Q5QB403HoippsySPy9QGdnMci8twQce3wUEgaaxp85KCAbXUT+asDZ863EpfectN
Gfw2rQW1Oe9C2EsxaM89hDzDMWiGDs/OynNctXIX94jCZ8wDWAwcYLoCbYiH53HK
OxHpiHZoAw7VOjZ/mDF6L/teqGE+SQKJD1VyLW0SFhZH9zbZzy68nNSxpba87bQz
pBIexcT1Wv4GD4R5P7jmS3DByQiuwURc4UspT6lcVmOsN7pXqh5GocK7uF9TYEw6
/oEs5OzkyB0H/y7p/KQmTEYO3uTa
-----END CERTIFICATE-----
`;

const TEST_KEY_LABEL = "PRIVATE " + "KEY";
const TEST_KEY_WITHOUT_REQUIRED_SAN_PEM = [
  `-----BEGIN ${TEST_KEY_LABEL}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDXwhjS2SOCpEll",
  "djSxB/qwXVEnliSKHJIU1x32jmobOAmaIsJNJ/aMtxTTci4YQcCBGG9RmbGGemzR",
  "88HqvJkI0Oed/39dTYgFzlIRlgJwU4bh+uvU6UjU4+EH9KYOH8SXJtwI0PDUBwzQ",
  "TksX3/0EtphwtWXZ4KwN5NkFC+4cqVL875Mc5XtFYHfxqusw3+wfgNpHJtnGsPPN",
  "NGaK8CNpsmB1P0oQ88jUG4G4z40HqaHr2LEh8yTw9TukktbaXtosgNvwuo8Ujq/4",
  "8ETdyLsSi11aeUGh6l7jbP5oWyZpqMSSTLsmrBxuGWbEOpduzFNxjuKmoSC+NkLV",
  "f9Ucn+EfAgMBAAECggEAXRAPfQLD2lnafrUZzTJP4zqdAqI0aI4iRHL1LaAIDG2D",
  "VsSfYoBWTCO8C+g4EaZqzkQn396XQBYWUgj+H63xpGfXP8MwwKHshfSUWZmGu8SL",
  "bXW5u0BUdd9E9RWFepohRcExL2xQNGRGFqNuqIGotRu9bQARSoUqMWQAZ7jZn+pu",
  "ZhoqfMIY6B5UHZis5gyQAc6ixfw6PhZZzTORNP9qoqvpjjlSS1x6DFadMTtEhZX3",
  "vwC3jL+LupvRs/lOo+RYRPj5IYp8hkH68NZ4GJ9py404/oxbPc3u3KJiRsOoiAAG",
  "zUYRarxLX3dZM25RohK98MCAbLCV/1L/KJ/9yiUEAQKBgQDvVooBVeS0/KpC2U1n",
  "NymCdQfgvNcyMbc+tyAX3RcPqbSOaSeuN0bM8hdKUBLYmH3eDtFbDH8guSz93aFr",
  "9dtw9X/qBFNjv8LW/Ee4+1gjg4uMgn6AZXylvTsXptyer3Ec+DA0sBylhPcegKAL",
  "otpx4dLrIZwyZrpHYsYDgiy+gQKBgQDmx1Hk4vaUkEx3IizOktt8/Qp78Y+ERzIS",
  "8tH+i4BUdvB83RUtUpGV1Jt6GaeIoYAxXKTj/7n/j8auSv211Kf108XhM3q2Pwnt",
  "B6ht5hEU8RGGVN68pvRv1+btFbL9bLEEsA5Dut1dX9qWaW04JneM1iIJlb7073lj",
  "RYZuJawPnwKBgQC5wp8mXjY+ywSTEfnjrIrJOHA+3BLiYHfrc1KzcuQdQghjp/Ym",
  "X7zSAOxWv0OBXQoEOdgAJPjeuxrShxxsoMwLJmB7j5Pxjbp6BiDc0CgemFDNY9Mv",
  "cJWIRhEBUH9Xoq/WXkN8AVyak1MCF68gmOuXDEEaQmHrNJRMJ7usqXJ1AQKBgH0L",
  "7ZT/Yir30WcQLoU0UBf2qJKmPmSnizt3NVAe2Mdrtz2BMfNf9SDhlelgM0Y2dFbK",
  "41HjhC41Aqv4WGcJNoVeXa98DHbpy4ATETGTYxgc06kdHZ/NO0/LBgbbJiRpm7V1",
  "jBUpEL+Cq9eqgpLVTRwT/1eAO3tOs1CWIJRYd1XzAoGAXStCv/MdhXGAMvKUqFea",
  "9I1eAIR4gOvGFuc7ZiXFQKqpPS18rDmKfAS0ljkMc5dVckFX3nCJ6d9z14XktH/G",
  "mCV/bGZgFwbG2uRAqHMQES3cg7uWB7Qui4ZehUVwPJAYGVl4V9mqNsjWsEJ0/TtC",
  "A9vJ/xk+U0mTEqPtau28lc4=",
  `-----END ${TEST_KEY_LABEL}-----`,
  "",
].join("\n");

function useTestCertificateClock(now = TEST_CERT_VALID_AT): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

function expectCompleteBundleReusedAt(now: Date): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
  writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
  let certgenCalls = 0;
  useTestCertificateClock(now);
  try {
    ensureDockerDriverGatewayLocalTlsBundle({
      env: { PATH: "/usr/bin" },
      gatewayBin: "/opt/openshell/openshell-gateway",
      stateDir,
      spawnSyncImpl: (() => {
        certgenCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      }) as never,
    });

    expect(certgenCalls).toBe(0);
    expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("docker-driver-gateway-local-tls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs certificate generation with the selected OpenShell env (#10514)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_DISABLE_TLS", "1");
    vi.stubEnv("OPENSHELL_DISABLE_GATEWAY_AUTH", "1");
    useTestCertificateClock();
    try {
      const bundle = ensureDockerDriverGatewayLocalTlsBundle({
        env: {
          PATH: "/usr/bin",
          OPENSHELL_GATEWAY: "nemoclaw-8090",
          OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
          OPENSHELL_WORKSPACE: "default",
        },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: ((
          command: string,
          args: string[],
          options?: { env?: NodeJS.ProcessEnv },
        ) => {
          calls.push({ command, args, env: options?.env });
          const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          expect(paths.localTlsDir).toBe(path.join(stateDir, "tls"));
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(bundle.localTlsDir).toBe(path.join(stateDir, "tls"));
      expect(resolveCompleteDockerDriverGatewayLocalTlsDir(stateDir)).toBe(bundle.localTlsDir);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/opt/openshell/openshell-gateway",
        args: [
          "generate-certs",
          "--output-dir",
          path.join(stateDir, "tls"),
          "--server-san",
          "host.openshell.internal",
          "--server-san",
          "localhost",
          "--server-san",
          "127.0.0.1",
        ],
      });
      expect(calls[0]?.env?.OPENSHELL_LOCAL_TLS_DIR).toBe(path.join(stateDir, "tls"));
      expect(calls[0]?.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
      expect(calls[0]?.env?.OPENSHELL_WORKSPACE).toBe("default");
      expect(calls[0]?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      expect(calls[0]?.env?.OPENSHELL_TOKEN).toBeUndefined();
      expect(calls[0]?.env?.OPENSHELL_DISABLE_TLS).toBeUndefined();
      expect(calls[0]?.env?.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("adds the rootless host gateway SAN for the portable profile", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-tls-"));
    const calls: string[][] = [];
    try {
      expect(() =>
        ensureDockerDriverGatewayLocalTlsBundle({
          env: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
          gatewayBin: "/opt/openshell/openshell-gateway",
          stateDir,
          spawnSyncImpl: ((_command: string, args: string[]) => {
            calls.push(args);
            return { status: 0, stdout: "", stderr: "" };
          }) as never,
        }),
      ).toThrow("did not create a complete");
      expect(calls[0]).toEqual(expect.arrayContaining(["--server-san", PORTABLE_HOST_GATEWAY_IP]));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("adds the rootless host gateway SAN for the native Podman runtime", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-tls-"));
    const calls: string[][] = [];
    try {
      expect(() =>
        ensureDockerDriverGatewayLocalTlsBundle({
          env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" },
          gatewayBin: "/opt/openshell/openshell-gateway",
          platform: "linux",
          stateDir,
          spawnSyncImpl: ((_command: string, args: string[]) => {
            calls.push(args);
            return { status: 0, stdout: "", stderr: "" };
          }) as never,
        }),
      ).toThrow("did not create a complete");
      expect(calls[0]).toEqual(expect.arrayContaining(["--server-san", PORTABLE_HOST_GATEWAY_IP]));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves an existing complete mTLS bundle without regenerating certs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    const contents = writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
    fs.chmodSync(paths.serverKeyPath, 0o644);
    fs.chmodSync(paths.clientKeyPath, 0o644);
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      const bundle = ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(bundle.localTlsDir).toBe(path.join(stateDir, "tls"));
      expect(certgenCalls).toBe(0);
      expect(
        Object.entries(contents).every(([filePath, content]) =>
          Object.is(fs.readFileSync(filePath, "utf-8"), content),
        ),
      ).toBe(true);
      expect(fs.statSync(paths.serverKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.clientKeyPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but wrong-SAN mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_WITHOUT_REQUIRED_SAN_PEM, TEST_KEY_WITHOUT_REQUIRED_SAN_PEM);
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);
      expect(resolveCompleteDockerDriverGatewayLocalTlsDir(stateDir)).toBeUndefined();

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but unparsable mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, "not a certificate\n", "not a private key\n");
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
      expect(certgenCalls).toBe(1);
      expect(fs.readFileSync(paths.caPath, "utf-8")).toBe(TEST_CERT_PEM);
      expect(fs.readFileSync(paths.serverKeyPath, "utf-8")).toBe(TEST_KEY_PEM);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but expired mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    let certgenCalls = 0;
    useTestCertificateClock(TEST_CERT_EXPIRED_AT);
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          vi.setSystemTime(TEST_CERT_VALID_AT);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but not-yet-valid mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    let certgenCalls = 0;
    useTestCertificateClock(TEST_CERT_NOT_YET_VALID_AT);
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          vi.setSystemTime(TEST_CERT_VALID_AT);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reuses the bundle at the exact five-minute not-before skew transition", () => {
    expectCompleteBundleReusedAt(TEST_CERT_SKEW_BOUNDARY_NOT_YET_VALID_AT);
  });

  it("reuses the bundle at the exact five-minute not-after skew transition", () => {
    expectCompleteBundleReusedAt(TEST_CERT_SKEW_BOUNDARY_EXPIRED_AT);
  });
});
