// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Support helpers for the corporate-proxy CA tests (#6210). Kept out of the
// *.test.ts files so branching setup stays in named helpers (the changed-test
// linear-body guardrail counts if statements only in test files).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/** Extract a marked block of shell text from a script for execution in tests. */
export function sliceBlock(scriptPath: string, startMarker: string, endMarker: string): string {
  const src = fs.readFileSync(scriptPath, "utf-8");
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to extract block [${startMarker} .. ${endMarker}] from ${scriptPath}`);
  }
  return src.slice(start, end);
}

export interface CaMaterial {
  ok: true;
  dir: string;
  corporateCaCert: string;
  openshellCaCert: string;
  serverKey: string;
  serverCert: string;
  openshellServerKey: string;
  openshellServerCert: string;
}

export type CaSetup = CaMaterial | { ok: false; reason: string };

// argv-based OpenSSL helpers (no shell string interpolation): paths and
// subjects are passed as separate arguments so a path can never be re-parsed as
// a flag or shell token.
function opensslReqX509(dir: string, cn: string, keyOut: string, certOut: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      path.join(dir, keyOut),
      "-out",
      path.join(dir, certOut),
      "-days",
      "7",
      "-nodes",
      "-subj",
      `/CN=${cn}`,
    ],
    { stdio: "pipe" },
  );
}

function signLeaf(
  dir: string,
  caCert: string,
  caKey: string,
  keyOut: string,
  certOut: string,
): void {
  const csr = path.join(dir, `${keyOut}.csr`);
  const ext = path.join(dir, `${keyOut}.ext`);
  fs.writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-keyout",
      path.join(dir, keyOut),
      "-out",
      csr,
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      path.join(dir, caCert),
      "-CAkey",
      path.join(dir, caKey),
      "-CAcreateserial",
      "-out",
      path.join(dir, certOut),
      "-days",
      "7",
      "-extfile",
      ext,
    ],
    { stdio: "pipe" },
  );
}

/**
 * Generate a corporate root + leaf and a separate OpenShell root + leaf.
 * Returns {ok:false} when openssl is unavailable; the caller decides whether to
 * skip (locally) or fail (CI).
 */
export function setupCaMaterial(): CaSetup {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
  } catch (err) {
    return { ok: false, reason: `openssl missing: ${(err as Error).message}` };
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-tls-"));
    opensslReqX509(dir, "Corp MITM Root CA", "corp-ca-key.pem", "corp-ca-cert.pem");
    signLeaf(dir, "corp-ca-cert.pem", "corp-ca-key.pem", "server-key.pem", "server-cert.pem");
    opensslReqX509(dir, "OpenShell Root CA", "openshell-ca-key.pem", "openshell-ca-cert.pem");
    signLeaf(
      dir,
      "openshell-ca-cert.pem",
      "openshell-ca-key.pem",
      "openshell-server-key.pem",
      "openshell-server-cert.pem",
    );
    return {
      ok: true,
      dir,
      corporateCaCert: path.join(dir, "corp-ca-cert.pem"),
      openshellCaCert: path.join(dir, "openshell-ca-cert.pem"),
      serverKey: path.join(dir, "server-key.pem"),
      serverCert: path.join(dir, "server-cert.pem"),
      openshellServerKey: path.join(dir, "openshell-server-key.pem"),
      openshellServerCert: path.join(dir, "openshell-server-cert.pem"),
    };
  } catch (err) {
    return { ok: false, reason: `cert generation failed: ${(err as Error).message}` };
  }
}

/**
 * Resolve CA material, failing loudly in CI (where openssl must exist) and
 * warning-and-skipping locally.
 */
export function resolveCaSetup(context: string): CaSetup {
  const setup = setupCaMaterial();
  if (!setup.ok) {
    if (process.env.CI === "true") {
      throw new Error(
        `[${context}] CI=true but openssl unavailable: ${setup.reason}. ` +
          "This test must not silently skip in CI — install openssl on the runner.",
      );
    }
    console.warn(`[${context}] skipping locally: ${setup.reason}`);
  }
  return setup;
}

export function cleanupCaSetup(setup: CaSetup): void {
  if (setup.ok) {
    fs.rmSync(setup.dir, { recursive: true, force: true });
  }
}

/**
 * Run the shipped merge_corporate_proxy_ca block from a start script against a
 * given OpenShell bundle + baked corporate CA, returning the merged bundle path.
 * Exercises the actual script text, not a re-implementation.
 */
export function runMergeBlock(
  scriptPath: string,
  openshellBundle: string,
  corporateCa: string,
  outDir: string,
  endMarker = "# Git TLS CA bundle fix (NemoClaw#2270).",
): string {
  const block = sliceBlock(scriptPath, "# Corporate proxy CA merge (NemoClaw#6210).", endMarker)
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corporateCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", path.join(outDir, "merged-ca.pem"));
  const wrapper = path.join(outDir, "merge.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export SSL_CERT_FILE=${JSON.stringify(openshellBundle)}`,
      block,
    ].join("\n"),
    { mode: 0o700 },
  );
  execFileSync("bash", [wrapper], { encoding: "utf-8" });
  return path.join(outDir, "merged-ca.pem");
}

export function startTlsServer(
  key: string,
  cert: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    );
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const settle = port
        ? resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
        : reject(new Error("server address unavailable"));
      return settle;
    });
  });
}

export function httpsGetStatus(port: number, caBundlePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: "127.0.0.1", port, path: "/", ca: fs.readFileSync(caBundlePath) },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
  });
}

/**
 * True when the host `base64` accepts GNU's `--decode` long option (as the
 * Dockerfiles require). BSD/macOS `base64` only accepts `-D`, so the extracted
 * RUN block cannot run there — callers skip the Dockerfile-decode test on such
 * hosts (the image itself is only ever built on Linux).
 */
export function hasGnuBase64Decode(): boolean {
  const res = spawnSync("bash", ["-c", "printf 'aGk=' | base64 --decode"], { encoding: "utf-8" });
  return res.status === 0 && res.stdout === "hi";
}

/**
 * True when the `openssl` CLI is available. The Dockerfile decode RUN block
 * requires openssl to validate the certificate bundle, so the Dockerfile-decode
 * test only runs where openssl is present (as the TLS e2e already requires).
 */
export function hasOpenssl(): boolean {
  return spawnSync("openssl", ["version"], { encoding: "utf-8" }).status === 0;
}

/**
 * Extract the shipped corporate-CA `base64 --decode` RUN block from a Dockerfile
 * and execute it (with the install path redirected to `outDir`) for a given
 * `NEMOCLAW_CORPORATE_CA_B64` value. Exercises the actual Dockerfile shell text,
 * not a re-implementation, so the malformed-input guards are validated as
 * shipped. Returns the exit status and stderr.
 */
export function runDockerfileCorporateCaDecode(
  dockerfilePath: string,
  b64Value: string,
  outDir: string,
): { status: number; stderr: string } {
  const lines = fs.readFileSync(dockerfilePath, "utf-8").split("\n");
  const startIdx = lines.findIndex((line) =>
    line.includes('RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then'),
  );
  const endIdx = lines.findIndex((line, idx) => idx > startIdx && line.trimEnd() === "    fi");
  const found = startIdx !== -1 && endIdx !== -1;
  const block = (found ? lines.slice(startIdx, endIdx + 1) : [])
    .join("\n")
    .replace(/^RUN /, "")
    .replaceAll("/usr/local/share/nemoclaw", outDir)
    // Redirect the fixed /tmp decode scratch path into the per-test dir so
    // concurrent test runs never collide.
    .replaceAll("/tmp/nemoclaw-corporate-ca.decoded", path.join(outDir, "decoded"))
    // Root ownership requires root; the test only exercises the base64/cert
    // guards, so chown to the current user keeps the shipped fail-fast `&&`
    // chain intact while running unprivileged.
    .replaceAll("chown root:root", 'chown "$(id -u):$(id -g)"');
  const wrapper = path.join(outDir, "decode.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `export NEMOCLAW_CORPORATE_CA_B64=${JSON.stringify(b64Value)}`,
      block || "echo 'decode block not found' >&2; exit 3",
    ].join("\n"),
    { mode: 0o700 },
  );
  const res = spawnSync("bash", [wrapper], { encoding: "utf-8" });
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

/** Run a bash wrapper built from the given lines and return stdout. */
export function runShellLines(dir: string, lines: string[]): string {
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  return execFileSync("bash", [script], { encoding: "utf-8" });
}
