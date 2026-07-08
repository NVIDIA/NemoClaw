// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Support helpers for the corporate-proxy CA tests (#6210). Kept out of the
// *.test.ts files so branching setup stays in named helpers (the changed-test
// linear-body guardrail counts if statements only in test files).

import { execFileSync } from "node:child_process";
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
): string {
  const block = sliceBlock(
    scriptPath,
    "# Corporate proxy CA merge (NemoClaw#6210).",
    "# Git TLS CA bundle fix (NemoClaw#2270).",
  )
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

/** Run a bash wrapper built from the given lines and return stdout. */
export function runShellLines(dir: string, lines: string[]): string {
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  return execFileSync("bash", [script], { encoding: "utf-8" });
}
