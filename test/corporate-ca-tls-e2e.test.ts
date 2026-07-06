// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused simulated-MITM TLS test for the corporate-proxy CA import (#6210).
//
// Reproduces the reporter's scenario without DGX hardware:
//   * A corporate root CA re-signs external TLS (the MITM proxy).
//   * A server presents a leaf cert signed ONLY by that corporate CA.
//   * OpenShell's own bundle does NOT contain the corporate root.
//
// It then runs the REAL `merge_corporate_proxy_ca` block extracted from
// scripts/nemoclaw-start.sh to append the baked corporate CA to the OpenShell
// bundle, and proves that:
//   * TLS verification against the server SUCCEEDS with the merged bundle.
//   * TLS verification FAILS with the OpenShell-only bundle (the pre-fix state).
//   * The OpenShell root is still trusted through the merged bundle (#1828
//     behavior preserved — the corporate CA is appended, not substituted).

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const NEMOCLAW_START_SCRIPT = path.join(import.meta.dirname, "../scripts/nemoclaw-start.sh");

interface CaMaterial {
  ok: true;
  dir: string;
  corporateCaCert: string; // path
  openshellCaCert: string; // path
  serverKey: string; // path
  serverCert: string; // path
  openshellServerKey: string; // path
  openshellServerCert: string; // path
}

function opensslReqX509(dir: string, cn: string, keyOut: string, certOut: string): void {
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${path.join(dir, keyOut)}" ` +
      `-out "${path.join(dir, certOut)}" -days 7 -nodes -subj "/CN=${cn}"`,
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
  execSync(
    `openssl req -newkey rsa:2048 -keyout "${path.join(dir, keyOut)}" -out "${csr}" ` +
      `-nodes -subj "/CN=localhost"`,
    { stdio: "pipe" },
  );
  execSync(
    `openssl x509 -req -in "${csr}" -CA "${path.join(dir, caCert)}" ` +
      `-CAkey "${path.join(dir, caKey)}" -CAcreateserial -out "${path.join(dir, certOut)}" ` +
      `-days 7 -extfile "${ext}"`,
    { stdio: "pipe" },
  );
}

function trySetup(): CaMaterial | { ok: false; reason: string } {
  try {
    execSync("openssl version", { stdio: "pipe" });
  } catch (err) {
    return { ok: false, reason: `openssl missing: ${(err as Error).message}` };
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corp-ca-tls-"));
    // Corporate MITM root + a leaf it signs.
    opensslReqX509(dir, "Corp MITM Root CA", "corp-ca-key.pem", "corp-ca-cert.pem");
    signLeaf(dir, "corp-ca-cert.pem", "corp-ca-key.pem", "server-key.pem", "server-cert.pem");
    // A separate OpenShell root + a leaf it signs (stands in for OpenShell's
    // own L7 proxy CA and inference.local traffic).
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

const setup = trySetup();
if (!setup.ok) {
  if (process.env.CI === "true") {
    throw new Error(
      `[corporate-ca-tls-e2e] CI=true but openssl unavailable: ${setup.reason}. ` +
        "This test must not silently skip in CI — install openssl on the runner.",
    );
  }
  console.warn(`[corporate-ca-tls-e2e] skipping locally: ${setup.reason}`);
}

afterAll(() => {
  if (setup.ok) {
    fs.rmSync(setup.dir, { recursive: true, force: true });
  }
});

/**
 * Run the shipped merge_corporate_proxy_ca block against a given OpenShell
 * bundle + baked corporate CA, returning the path of the produced merged
 * bundle. Exercises the actual script text, not a re-implementation.
 */
function runMergeBlock(openshellBundle: string, corporateCa: string, outDir: string): string {
  const src = fs.readFileSync(NEMOCLAW_START_SCRIPT, "utf-8");
  const start = src.indexOf("# Corporate proxy CA merge (NemoClaw#6210).");
  const end = src.indexOf("# Git TLS CA bundle fix (NemoClaw#2270).", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Failed to extract corporate CA merge block from nemoclaw-start.sh");
  }
  const merged = path.join(outDir, "merged-ca.pem");
  const block = src
    .slice(start, end)
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corporateCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", merged);
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
  return merged;
}

function startServer(
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
      if (!addr || typeof addr === "string") {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function httpsGet(port: number, caBundlePath: string): Promise<number> {
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

describe.skipIf(!setup.ok)("corporate proxy CA TLS verification (#6210)", () => {
  const mat = setup as CaMaterial;

  it("verifies a corporate-CA-signed endpoint only after the merge", async () => {
    const merged = runMergeBlock(mat.openshellCaCert, mat.corporateCaCert, mat.dir);
    const server = await startServer(mat.serverKey, mat.serverCert);
    try {
      // Pre-fix state: OpenShell bundle alone cannot verify the corporate leaf.
      await expect(httpsGet(server.port, mat.openshellCaCert)).rejects.toThrow(
        /unable to (get local issuer|verify)|self.signed|UNABLE_TO_/i,
      );
      // Post-fix: the merged bundle trusts the corporate root.
      await expect(httpsGet(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });

  // Also preserves the OpenShell CA trust behavior from #1828.
  it("still trusts the OpenShell root through the merged bundle (#6210)", async () => {
    const merged = runMergeBlock(mat.openshellCaCert, mat.corporateCaCert, mat.dir);
    const server = await startServer(mat.openshellServerKey, mat.openshellServerCert);
    try {
      await expect(httpsGet(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });
});
