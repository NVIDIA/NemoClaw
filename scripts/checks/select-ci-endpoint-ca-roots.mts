// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CI_CA_SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
export const CI_CA_ENDPOINTS = Object.freeze([
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
] as const);
export const MAX_CI_CA_CERTIFICATES = 24;
export const MAX_CI_CA_ENCODED_BYTES = 65_536;

const PEM_RE = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/gu;
const OPENSSL_TIMEOUT_MS = 30_000;

type CertificateRecord = { readonly cert: X509Certificate; readonly pem: string };
type OpenSslResult = {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};
export type OpenSslRunner = (args: readonly string[]) => OpenSslResult;

function runOpenSsl(args: readonly string[]): OpenSslResult {
  const result = spawnSync("openssl", [...args], {
    encoding: "utf8",
    input: "",
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    timeout: OPENSSL_TIMEOUT_MS,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function parseCertificates(bundle: string, label: string): CertificateRecord[] {
  const blocks = bundle.match(PEM_RE);
  if (!blocks?.length) throw new Error(`${label} contains no PEM certificate`);
  return blocks.map((pem, index) => {
    try {
      return { cert: new X509Certificate(pem), pem: pem.trim() };
    } catch {
      throw new Error(`${label} certificate ${index + 1} is not valid X.509`);
    }
  });
}

function isSignedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function isSelfSigned(cert: X509Certificate): boolean {
  return cert.subject === cert.issuer && isSignedBy(cert, cert);
}

function isCurrentSelfSignedRoot(cert: X509Certificate, nowMs = Date.now()): boolean {
  const validFromMs = Date.parse(cert.validFrom);
  const validToMs = Date.parse(cert.validTo);
  if (
    !cert.ca ||
    !isSelfSigned(cert) ||
    Number.isNaN(validFromMs) ||
    Number.isNaN(validToMs) ||
    nowMs < validFromMs ||
    nowMs > validToMs
  ) {
    return false;
  }
  return true;
}

function fingerprint(cert: X509Certificate): string {
  return cert.fingerprint256.replaceAll(":", "").toLowerCase();
}

export function normalizeCompactRootBundle(
  roots: readonly string[],
  limits: { readonly certificates: number; readonly encodedBytes: number } = {
    certificates: MAX_CI_CA_CERTIFICATES,
    encodedBytes: MAX_CI_CA_ENCODED_BYTES,
  },
): string {
  const unique = new Map<string, CertificateRecord>();
  for (const [index, pem] of roots.entries()) {
    const records = parseCertificates(pem, `selected root ${index + 1}`);
    if (records.length !== 1 || !isCurrentSelfSignedRoot(records[0].cert)) {
      throw new Error(`selected root ${index + 1} must be a current self-signed CA:TRUE root`);
    }
    unique.set(fingerprint(records[0].cert), records[0]);
  }
  if (unique.size === 0) throw new Error("selected root bundle is empty");
  if (unique.size > limits.certificates) {
    throw new Error(`selected root bundle exceeds ${limits.certificates} certificates`);
  }
  const bundle = `${[...unique.values()].map(({ pem }) => pem).join("\n")}\n`;
  if (Buffer.from(bundle).toString("base64").length > limits.encodedBytes) {
    throw new Error(`selected root bundle exceeds ${limits.encodedBytes} encoded bytes`);
  }
  return bundle;
}

function opensslOutput(
  runner: OpenSslRunner,
  args: readonly string[],
  label: string,
  requireVerifyOk = false,
): string {
  const result = runner(args);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed without emitting certificate data`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (requireVerifyOk && !/Verify return code:\s*0\s*\(ok\)/iu.test(output)) {
    throw new Error(`${label} did not report successful certificate verification`);
  }
  return output;
}

function connectionArgs(endpoint: string, caFile: string, showCerts: boolean): string[] {
  return [
    "s_client",
    "-connect",
    `${endpoint}:443`,
    "-servername",
    endpoint,
    "-verify_hostname",
    endpoint,
    "-verify_return_error",
    "-CAfile",
    caFile,
    "-no-CApath",
    "-no-CAstore",
    ...(showCerts ? ["-showcerts"] : []),
  ];
}

function systemRoots(systemBundle: string): CertificateRecord[] {
  const roots = new Map<string, CertificateRecord>();
  for (const record of parseCertificates(systemBundle, "system CA bundle")) {
    if (isCurrentSelfSignedRoot(record.cert)) roots.set(fingerprint(record.cert), record);
  }
  if (roots.size === 0) throw new Error("system CA bundle contains no current CA:TRUE root");
  return [...roots.values()];
}

function verifiesOffline(
  runner: OpenSslRunner,
  endpoint: string,
  chain: readonly CertificateRecord[],
  root: CertificateRecord,
  tempDir: string,
): boolean {
  const stem = path.join(tempDir, endpoint);
  const leaf = `${stem}-leaf.pem`;
  const intermediates = `${stem}-intermediates.pem`;
  const rootFile = `${stem}-root.pem`;
  fs.writeFileSync(leaf, `${chain[0].pem}\n`, { mode: 0o600 });
  fs.writeFileSync(rootFile, `${root.pem}\n`, { mode: 0o600 });
  const untrusted = chain.slice(1).filter(({ cert }) => !isSelfSigned(cert));
  if (untrusted.length) {
    fs.writeFileSync(intermediates, `${untrusted.map(({ pem }) => pem).join("\n")}\n`, {
      mode: 0o600,
    });
  }
  const result = runner([
    "verify",
    "-purpose",
    "sslserver",
    "-verify_hostname",
    endpoint,
    "-CAfile",
    rootFile,
    "-no-CApath",
    "-no-CAstore",
    ...(untrusted.length ? ["-untrusted", intermediates] : []),
    leaf,
  ]);
  return !result.error && result.status === 0;
}

function selectRoot(
  runner: OpenSslRunner,
  endpoint: string,
  chain: readonly CertificateRecord[],
  roots: readonly CertificateRecord[],
  tempDir: string,
): CertificateRecord {
  const untrusted = chain.filter(({ cert }) => !isSelfSigned(cert));
  const candidates = roots
    .filter(({ cert: root }) =>
      untrusted.some(({ cert }) => cert.issuer === root.subject && isSignedBy(cert, root)),
    )
    .sort((left, right) => fingerprint(left.cert).localeCompare(fingerprint(right.cert)));
  const selected = candidates.find((root) =>
    verifiesOffline(runner, endpoint, chain, root, tempDir),
  );
  if (!selected) throw new Error(`no system CA root verifies the chain for ${endpoint}`);
  return selected;
}

export function writeCiEndpointCaRootsOutput(outputPath: string, bundle: string): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("output requires O_NOFOLLOW support");
  }

  let fd: number;
  try {
    // Open without following symlinks or blocking on special files, then validate before writing.
    fd = fs.openSync(
      outputPath,
      fs.constants.O_WRONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    throw new Error("output must be an existing regular file that is not a symlink", {
      cause: error,
    });
  }
  try {
    const opened = fs.fstatSync(fd);
    const afterOpen = fs.lstatSync(outputPath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !afterOpen.isFile() ||
      afterOpen.isSymbolicLink() ||
      afterOpen.nlink !== 1 ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino
    ) {
      throw new Error("output must remain the same regular file with exactly one link");
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, bundle);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

export function selectCiEndpointCaRoots(
  outputPath: string,
  runner: OpenSslRunner = runOpenSsl,
): { readonly certificates: number; readonly encodedBytes: number } {
  if (path.resolve(outputPath) === path.resolve(CI_CA_SYSTEM_BUNDLE)) {
    throw new Error("output must not replace the system CA bundle");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ci-ca-roots-"));
  try {
    opensslOutput(runner, ["version"], "OpenSSL availability check");
    const roots = systemRoots(fs.readFileSync(CI_CA_SYSTEM_BUNDLE, "utf8"));
    const selected = CI_CA_ENDPOINTS.map((endpoint) => {
      const chainOutput = opensslOutput(
        runner,
        connectionArgs(endpoint, CI_CA_SYSTEM_BUNDLE, true),
        `system CA verification for ${endpoint}`,
        true,
      );
      return selectRoot(
        runner,
        endpoint,
        parseCertificates(chainOutput, `server chain for ${endpoint}`),
        roots,
        tempDir,
      );
    });
    const bundle = normalizeCompactRootBundle(selected.map(({ pem }) => pem));
    const compactPath = path.join(tempDir, "compact.pem");
    fs.writeFileSync(compactPath, bundle, { mode: 0o600 });
    for (const endpoint of CI_CA_ENDPOINTS) {
      opensslOutput(
        runner,
        connectionArgs(endpoint, compactPath, false),
        `compact CA verification for ${endpoint}`,
        true,
      );
    }
    writeCiEndpointCaRootsOutput(outputPath, bundle);
    return {
      certificates: parseCertificates(bundle, "compact CA bundle").length,
      encodedBytes: Buffer.from(bundle).toString("base64").length,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): void {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("usage: select-ci-endpoint-ca-roots.mts --output <existing-file>");
  }
  const result = selectCiEndpointCaRoots(argv[1]);
  process.stdout.write(
    `Selected CA roots: ${result.certificates} (${result.encodedBytes} encoded bytes).\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
