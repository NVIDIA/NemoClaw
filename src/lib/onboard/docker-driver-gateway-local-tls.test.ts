// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dockerDriverGatewayLocalTlsBundleIsComplete,
  ensureDockerDriverGatewayLocalTlsBundle,
  getDockerDriverGatewayLocalTlsBundle,
} from "./docker-driver-gateway-local-tls";

const TEST_CERT_VALID_AT = new Date("2026-06-27T00:00:00.000Z");
const TEST_CERT_SKEW_BOUNDARY_NOT_YET_VALID_AT = new Date("2026-06-26T20:38:47.000Z");
const TEST_CERT_NOT_YET_VALID_AT = new Date("2026-06-26T20:38:46.000Z");
const TEST_CERT_SKEW_BOUNDARY_EXPIRED_AT = new Date("2036-06-23T20:48:47.000Z");
const TEST_CERT_EXPIRED_AT = new Date("2036-06-23T20:48:48.000Z");

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDSDCCAjCgAwIBAgIUBpjeCY46iq7RCJIJJRARHcI2jUkwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNbmVtb2NsYXctdGVzdDAeFw0yNjA2MjYyMDQzNDdaFw0z
NjA2MjMyMDQzNDdaMBgxFjAUBgNVBAMMDW5lbW9jbGF3LXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCNNYxZ+eNXrah+l9KkvH+frUAZFA+WY5Mp
EM2ghtxP5r9CE4izEdKRdk+bq85mVW17M9u+vLA0F0FmFRzAGV74qW+DJgbbefxR
J6tcowGACoAbNBvELpkQpDBqeLtQdtcSK92RLiRCmP94m21xTkF77Kvg2HeddvUn
SZJ+SgBscgNVo1Hdf85YMVwxg51n0bhtZmk2WXnAbqCj/Zmka6lKbhomcMaPKuDV
bz+VKy+9xPK+/sio9wsdFQ9X6Z6liUwID9Z2hjneZXfYycUGTSddcBuqe2s61MZA
ntQCzsnwzJxgl1BBZ/FbE4eCO0QL1mPc9wDkD2299nrtZ9gsQYLXAgMBAAGjgYkw
gYYwHQYDVR0OBBYEFPIKiGBTsTkY0/DkeDxK9zcBbctYMB8GA1UdIwQYMBaAFPIK
iGBTsTkY0/DkeDxK9zcBbctYMA8GA1UdEwEB/wQFMAMBAf8wMwYDVR0RBCwwKoIX
aG9zdC5vcGVuc2hlbGwuaW50ZXJuYWyCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG
9w0BAQsFAAOCAQEAfoS+BKlCJNVovT3TMrhiBUhIAtYbBBESp3a2W/vgiV2hZO8o
UDY8lt8Pa2BuU3bwLBnMpr3iChdKLJ70KofqJAgRS6lEgkTXejfoRETuHngqIB5F
Kwz7iSdNmbMNaSaG0JsBpsmTLdkoXVbCoburV534yG0VLDSdGy0dEklxRP2OEQ1s
eyP7541jrt1kFMyPWQ/SaLmFYYCKtYGe1PtKYw0HJf4UQGbNJC8TRZ9KyqfcSdMr
8gMJ6LlArc4hplBJV19dbQJmMpWfQZFpzOzV1lK46YAJSlaUGKzoreaGs4GzHYHD
vTUDCPebEbi9VRlMpX9j7ti+yqqFitz/42+JeA==
-----END CERTIFICATE-----
`;

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
const TEST_KEY_PEM = [
  `-----BEGIN ${TEST_KEY_LABEL}-----`,
  "MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCNNYxZ+eNXrah+",
  "l9KkvH+frUAZFA+WY5MpEM2ghtxP5r9CE4izEdKRdk+bq85mVW17M9u+vLA0F0Fm",
  "FRzAGV74qW+DJgbbefxRJ6tcowGACoAbNBvELpkQpDBqeLtQdtcSK92RLiRCmP94",
  "m21xTkF77Kvg2HeddvUnSZJ+SgBscgNVo1Hdf85YMVwxg51n0bhtZmk2WXnAbqCj",
  "/Zmka6lKbhomcMaPKuDVbz+VKy+9xPK+/sio9wsdFQ9X6Z6liUwID9Z2hjneZXfY",
  "ycUGTSddcBuqe2s61MZAntQCzsnwzJxgl1BBZ/FbE4eCO0QL1mPc9wDkD2299nrt",
  "Z9gsQYLXAgMBAAECggEAQzZLucABgAg+fRMSxiqarIwwSD+OM8ztjMxcs529W6K/",
  "Qlo95M4E5gvkVHpwYbEjzVKfs6foTsMK8+X0q1LoK3+qfkgpV2o2uQIixJMp8aIN",
  "2+Tvmm97l7ou+V7B+ci3EgUjDylhRPnCD8wbSaUv8iZyoTEnriGjCrIwMkBS90qQ",
  "VbNd3oIyl/CgK5KSgHdyx8Zg8HXs/49pd4J77TgEqP5EBM4y8NI60iEzEWqgocY/",
  "KnotfPcBBSwfFJ7R0hqYGdy+x7mjxlW8IRDL86R+/EfFgi1+DkhF6xjtvhcw9Hqf",
  "dRrMnEDTQrQF0K53X5UIHXNSDeZsl11mAPZS4GryIQKBgQDCQlkbpBITTPrKqqaQ",
  "j4QEVRLbK/H4Fc52L9Upag4dNrmpGDPL0pHQIhUDVpgBh0oMt+7xTGuspYu+/UMW",
  "DX85V+YcoGn2394lcTsaXrLOtsm8c2EEjrqv/wjbITxyVxIpUj+OpEhzfnEG8Squ",
  "z7NFP9wmL43iOOZNtN+FSr7FmQKBgQC6FtqjEAzEfy4p9OBhqTKLpHAsib+3dR1T",
  "es5IvWCzFVauDjQeR6BW3W+xugGcDE6KsonG200YvcbDfPSTYufdouCqH/ehjViB",
  "zMVuCU7r597eXtC8WiWj7O9WGdh31tKPrunBhecVLlSIxICJ08LO48ki0MyAQwxs",
  "U9NI/nLx7wKBgQC29P4vxksv2mSp1CekJ0bTPbzQp4bxfLhDH7HHm5dHdG9QDvdZ",
  "lCy4tiDMUBZB+kWHzQRCRxNyO0huzOEOOBAG1f5oH70tQpNa+FYN8/q8LfO6hYBu",
  "Zm71q2GP4LGpjtAQEuLBWYDTJdcWDrWAhyX0pryVSlx7H9Pog92xEEC0oQKBgQCE",
  "hpwkftyo3+4vgS5/PrE5k90zStKXQ7ej6RSZ5wzD3RGDGahyXA5Lbp4KE27sBDO3",
  "QRkv3qRUV2sDc6z2ffyk8kdPwT5o9jGvFvcPu19SUCp/cUT0rrqZuLZmOjfYeMwx",
  "+Z6N7N+6TOl1EYR9I6tcDgsDWXIaciWZzETveg7ATwKBgQCpeLMdb0ChKj4NaZmp",
  "x+WjgREJCp6/RapH3l4HIpADjByZIBlOZRBfJjhEm19HbvLIRep42F9+Qh0HCHbU",
  "5Sh6Odw+MzFyF27Kqatrt5jZKFQqAeT0wLDE/+MhG3XoEJKOqfDMJNKNRsIQa50c",
  "NKQ/hhZnPYQ4uv8naNDfKfk8bw==",
  `-----END ${TEST_KEY_LABEL}-----`,
  "",
].join("\n");

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

function writeBundle(
  stateDir: string,
  certContent: string,
  keyContent: string,
): Record<string, string> {
  const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
  const contents = {
    [paths.caPath]: certContent,
    [paths.serverCertPath]: certContent,
    [paths.serverKeyPath]: keyContent,
    [paths.clientCertPath]: certContent,
    [paths.clientKeyPath]: keyContent,
  };
  for (const [filePath, content] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return contents;
}

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

  it("runs OpenShell certgen into the NemoClaw-owned gateway TLS directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    useTestCertificateClock();
    try {
      const bundle = ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
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
      for (const [filePath, content] of Object.entries(contents)) {
        expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
      }
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
