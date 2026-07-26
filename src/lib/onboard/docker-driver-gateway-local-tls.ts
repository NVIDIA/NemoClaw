// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// See docs/security/openshell-0.0.72-compatibility-review.mdx for the source-of-truth review.
export const DOCKER_DRIVER_GATEWAY_LOCAL_TLS_DIR_NAME = "tls";

const REQUIRED_SERVER_DNS_SANS = ["host.openshell.internal", "localhost"];
const REQUIRED_SERVER_IP_SANS = ["127.0.0.1"];
const CERTIFICATE_VALIDITY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type DockerDriverGatewayLocalTlsBundle = {
  localTlsDir: string;
  caPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
};

export interface EnsureDockerDriverGatewayLocalTlsBundleOptions {
  env?: NodeJS.ProcessEnv;
  gatewayBin: string;
  spawnSyncImpl?: typeof spawnSync;
  stateDir: string;
}

export function getDockerDriverGatewayLocalTlsDir(stateDir: string): string {
  return path.join(stateDir, DOCKER_DRIVER_GATEWAY_LOCAL_TLS_DIR_NAME);
}

export function getDockerDriverGatewayLocalTlsBundle(
  stateDir: string,
): DockerDriverGatewayLocalTlsBundle {
  const localTlsDir = getDockerDriverGatewayLocalTlsDir(stateDir);
  return {
    localTlsDir,
    caPath: path.join(localTlsDir, "ca.crt"),
    serverCertPath: path.join(localTlsDir, "server", "tls.crt"),
    serverKeyPath: path.join(localTlsDir, "server", "tls.key"),
    clientCertPath: path.join(localTlsDir, "client", "tls.crt"),
    clientKeyPath: path.join(localTlsDir, "client", "tls.key"),
  };
}

export function dockerDriverGatewayLocalTlsBundleIsComplete(stateDir: string): boolean {
  const bundle = getDockerDriverGatewayLocalTlsBundle(stateDir);
  const expectedFiles = [
    bundle.caPath,
    bundle.serverCertPath,
    bundle.serverKeyPath,
    bundle.clientCertPath,
    bundle.clientKeyPath,
  ];
  if (!expectedFiles.every((candidate) => fs.existsSync(candidate))) return false;

  const ca = readCertificate(bundle.caPath);
  const serverCert = readCertificate(bundle.serverCertPath);
  const clientCert = readCertificate(bundle.clientCertPath);
  const serverKey = readPrivateKey(bundle.serverKeyPath);
  const clientKey = readPrivateKey(bundle.clientKeyPath);
  if (!ca || !serverCert || !clientCert || !serverKey || !clientKey) return false;

  const nowMs = Date.now();
  return (
    certificateIsCurrentlyValid(ca, nowMs) &&
    certificateIsCurrentlyValid(serverCert, nowMs) &&
    certificateIsCurrentlyValid(clientCert, nowMs) &&
    certificateMatchesPrivateKey(serverCert, serverKey) &&
    certificateMatchesPrivateKey(clientCert, clientKey) &&
    certificateVerifiesAgainstCa(serverCert, ca) &&
    certificateVerifiesAgainstCa(clientCert, ca) &&
    certificateHasRequiredServerSubjectAltNames(serverCert)
  );
}

export function buildDockerDriverGatewayLocalTlsEnv(stateDir: string): Record<string, string> {
  return {
    OPENSHELL_LOCAL_TLS_DIR: getDockerDriverGatewayLocalTlsDir(stateDir),
  };
}

function text(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function redactPemPrivateKeys(value: string): string {
  return value.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "<redacted private key>",
  );
}

function sanitizeDockerDriverGatewayLocalTlsErrorDetail(
  detail: string,
  bundle: DockerDriverGatewayLocalTlsBundle,
  stateDir: string,
): string {
  return redactPemPrivateKeys(detail)
    .split(bundle.localTlsDir)
    .join("<stateDir>/tls")
    .split(stateDir)
    .join("<stateDir>");
}

function readCertificate(filePath: string): X509Certificate | null {
  try {
    return new X509Certificate(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function readPrivateKey(filePath: string): KeyObject | null {
  try {
    return createPrivateKey(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function certificateIsCurrentlyValid(certificate: X509Certificate, nowMs: number): boolean {
  const validFromMs = Date.parse(certificate.validFrom);
  const validToMs = Date.parse(certificate.validTo);
  if (Number.isNaN(validFromMs) || Number.isNaN(validToMs)) return false;
  return (
    validFromMs - CERTIFICATE_VALIDITY_CLOCK_SKEW_MS <= nowMs &&
    nowMs <= validToMs + CERTIFICATE_VALIDITY_CLOCK_SKEW_MS
  );
}

function certificateMatchesPrivateKey(
  certificate: X509Certificate,
  privateKey: KeyObject,
): boolean {
  try {
    const certPublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
    const keyPublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    return Buffer.from(certPublicKey).equals(Buffer.from(keyPublicKey));
  } catch {
    return false;
  }
}

function certificateVerifiesAgainstCa(certificate: X509Certificate, ca: X509Certificate): boolean {
  try {
    return certificate.verify(ca.publicKey);
  } catch {
    return false;
  }
}

function certificateHasRequiredServerSubjectAltNames(certificate: X509Certificate): boolean {
  const subjectAltNames = new Set(
    (certificate.subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return (
    REQUIRED_SERVER_DNS_SANS.every((dnsName) => subjectAltNames.has(`dns:${dnsName}`)) &&
    REQUIRED_SERVER_IP_SANS.every(
      (ipAddress) =>
        subjectAltNames.has(`ip address:${ipAddress}`) || subjectAltNames.has(`ip:${ipAddress}`),
    )
  );
}

function normalizeDockerDriverGatewayLocalTlsBundlePermissions(
  bundle: DockerDriverGatewayLocalTlsBundle,
): void {
  fs.chmodSync(bundle.serverKeyPath, 0o600);
  fs.chmodSync(bundle.clientKeyPath, 0o600);
}

export function ensureDockerDriverGatewayLocalTlsBundle({
  env = process.env,
  gatewayBin,
  spawnSyncImpl = spawnSync,
  stateDir,
}: EnsureDockerDriverGatewayLocalTlsBundleOptions): DockerDriverGatewayLocalTlsBundle {
  const bundle = getDockerDriverGatewayLocalTlsBundle(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  if (dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)) {
    normalizeDockerDriverGatewayLocalTlsBundlePermissions(bundle);
    return bundle;
  }

  const result = spawnSyncImpl(
    gatewayBin,
    [
      "generate-certs",
      "--output-dir",
      bundle.localTlsDir,
      "--server-san",
      "host.openshell.internal",
      "--server-san",
      "localhost",
      "--server-san",
      "127.0.0.1",
    ],
    {
      encoding: "utf-8",
      env: {
        ...env,
        OPENSHELL_LOCAL_TLS_DIR: bundle.localTlsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    } satisfies SpawnSyncOptions,
  );
  if (result.error) {
    throw new Error(
      `OpenShell gateway certificate generation failed: ${sanitizeDockerDriverGatewayLocalTlsErrorDetail(
        result.error.message,
        bundle,
        stateDir,
      )}`,
    );
  }
  if (result.status !== 0) {
    const rawDetail = text(result.stderr).trim() || text(result.stdout).trim() || "unknown error";
    const detail = sanitizeDockerDriverGatewayLocalTlsErrorDetail(rawDetail, bundle, stateDir);
    throw new Error(`OpenShell gateway certificate generation failed: ${detail}`);
  }
  if (!dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)) {
    const detail = sanitizeDockerDriverGatewayLocalTlsErrorDetail(
      `incomplete mTLS bundle in ${bundle.localTlsDir}`,
      bundle,
      stateDir,
    );
    throw new Error(
      `OpenShell gateway certificate generation did not create a complete, valid mTLS bundle: ${detail}`,
    );
  }
  normalizeDockerDriverGatewayLocalTlsBundlePermissions(bundle);

  return bundle;
}
