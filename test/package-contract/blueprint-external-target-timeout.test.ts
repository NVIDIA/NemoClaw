// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const RUNNER = path.join(REPOSITORY_ROOT, "dist", "lib", "blueprint-runner.js");
const SYSTEM_CA_PEM = rootCertificates[0]!;
const UNSAFE_DIAGNOSTIC_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

type TlsMaterial = Readonly<{
  caPath: string;
  certificatePath: string;
  keyPath: string;
}>;

function externalIpv4Address(): string {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  assert.ok(address, "the package contract requires one non-loopback IPv4 interface");
  return address;
}

function listen(server: net.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runOpenSsl(args: string[], cwd: string): void {
  const result = spawnSync("openssl", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, "OpenSSL could not create the package TLS fixture");
}

function createTlsMaterial(root: string, serverSan: string): TlsMaterial {
  fs.mkdirSync(root, { recursive: true });
  const caPath = path.join(root, "ca.pem");
  const caKeyPath = path.join(root, "ca-key.pem");
  const requestPath = path.join(root, "server.csr");
  const certificatePath = path.join(root, "server.pem");
  const keyPath = path.join(root, "server-key.pem");
  const extensionPath = path.join(root, "server.ext");

  runOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caPath,
      "-subj",
      "/CN=NemoClaw package contract CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    root,
  );
  runOpenSsl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      requestPath,
      "-subj",
      "/CN=NemoClaw package contract gateway",
    ],
    root,
  );
  fs.writeFileSync(
    extensionPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=IP:${serverSan}`,
      "",
    ].join("\n"),
  );
  runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      requestPath,
      "-CA",
      caPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      certificatePath,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensionPath,
    ],
    root,
  );
  fs.chmodSync(caKeyPath, 0o600);
  fs.chmodSync(keyPath, 0o600);
  return { caPath, certificatePath, keyPath };
}

function createTlsServer(
  material: TlsMaterial,
  sockets: Set<Socket>,
  observedConnections: { count: number },
): tls.Server {
  const server = tls.createServer(
    {
      ALPNProtocols: ["h2"],
      cert: fs.readFileSync(material.certificatePath),
      key: fs.readFileSync(material.keyPath),
    },
    () => undefined,
  );
  server.on("connection", (socket) => {
    observedConnections.count += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => undefined);
  return server;
}

function writeExternalBlueprint(
  fixtureRoot: string,
  address: string,
  port: number,
  caContents: string,
): string {
  const blueprintRoot = path.join(fixtureRoot, "blueprint");
  const caPath = path.join(fixtureRoot, "configured-ca.pem");
  const authenticationPath = path.join(fixtureRoot, "authentication");
  fs.mkdirSync(blueprintRoot, { recursive: true });
  fs.writeFileSync(caPath, caContents);
  fs.writeFileSync(authenticationPath, "opaque-authentication-metadata");
  fs.writeFileSync(
    path.join(blueprintRoot, "blueprint.yaml"),
    YAML.stringify({
      version: "1.0.0",
      min_openshell_version: "0.0.106",
      max_openshell_version: "0.0.106",
      openshell_target: {
        endpoint: `https://${address}:${String(port)}`,
        workspace: "default",
        expected_release: "0.0.106",
        lifecycle: "external",
        trust: { ca_file: caPath },
        authentication: { credential_file: authenticationPath },
      },
    }),
  );
  return blueprintRoot;
}

function runRunner(
  runtimeRoot: string,
  blueprintRoot: string,
): Promise<
  Readonly<{ code: number | null; durationMs: number; stderr: string; timedOut: boolean }>
> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUNNER, "status", "--external-target"], {
      cwd: runtimeRoot,
      env: { ...process.env, NEMOCLAW_BLUEPRINT_PATH: blueprintRoot },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 8_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, durationMs: Date.now() - startedAt, stderr, timedOut });
    });
  });
}

function expectFixedReachabilityFailure(
  result: Awaited<ReturnType<typeof runRunner>>,
  fixtureRoot: string,
): void {
  expect(result.timedOut, result.stderr).toBe(false);
  expect(result.code, result.stderr).toBe(1);
  expect(result.durationMs).toBeLessThan(7_000);
  expect(result.stderr).toContain("NemoClaw could not reach the external OpenShell target.");
  expect(result.stderr).not.toContain(fixtureRoot);
  expect(result.stderr).not.toContain("BEGIN CERTIFICATE");
  expect(result.stderr.endsWith("\n")).toBe(true);
  expect(result.stderr.slice(0, -1)).not.toMatch(UNSAFE_DIAGNOSTIC_CHARACTERS);
}

describe("packaged Blueprint Runner external health deadline", () => {
  it(
    "returns a fixed reachability failure within the deadline when the TLS peer stalls (#9872)",
    { timeout: 20_000 },
    async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-timeout-"));
      const sockets = new Set<Socket>();
      const observedConnections = { count: 0 };

      try {
        const address = externalIpv4Address();
        const material = createTlsMaterial(path.join(fixtureRoot, "tls"), address);
        const server = createTlsServer(material, sockets, observedConnections);
        try {
          const port = await listen(server, address);
          const blueprintRoot = writeExternalBlueprint(
            fixtureRoot,
            address,
            port,
            fs.readFileSync(material.caPath, "utf8"),
          );

          const result = await runRunner(fixtureRoot, blueprintRoot);

          expectFixedReachabilityFailure(result, fixtureRoot);
          expect(observedConnections.count).toBeGreaterThan(0);
        } finally {
          sockets.forEach((socket) => socket.destroy());
          await close(server);
        }
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "wrong CA", serverSan: "target", trustGeneratedCa: false },
    { name: "wrong server identity", serverSan: "192.0.2.123", trustGeneratedCa: true },
  ])("rejects a $name with fixed diagnostics (#9872)", async (testCase) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-health-identity-"));
    const sockets = new Set<Socket>();
    const observedConnections = { count: 0 };

    try {
      const address = externalIpv4Address();
      const material = createTlsMaterial(
        path.join(fixtureRoot, "tls"),
        testCase.serverSan === "target" ? address : testCase.serverSan,
      );
      const server = createTlsServer(material, sockets, observedConnections);
      try {
        const port = await listen(server, address);
        const blueprintRoot = writeExternalBlueprint(
          fixtureRoot,
          address,
          port,
          testCase.trustGeneratedCa ? fs.readFileSync(material.caPath, "utf8") : SYSTEM_CA_PEM,
        );

        const result = await runRunner(fixtureRoot, blueprintRoot);

        expectFixedReachabilityFailure(result, fixtureRoot);
        expect(result.durationMs).toBeLessThan(4_500);
      } finally {
        sockets.forEach((socket) => socket.destroy());
        await close(server);
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
