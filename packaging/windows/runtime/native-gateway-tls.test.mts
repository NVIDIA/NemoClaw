// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import tls from "node:tls";
import test from "node:test";

// Component interoperability only: this is not an OpenShell authorization or
// installed acceptance test. The compiled fixture includes the production helper.
const helper = process.env.NEMOCLAW_GATEWAY_TLS_CONTROL;
const options = { skip: !helper || process.platform !== "win32", timeout: 30_000 };
type Material = {
  schemaVersion: number;
  caCertificate: string;
  serverCertificate: string;
  serverPrivateKey: string;
  clientCertificate: string;
  clientPrivateKey: string;
};

function material(): Material {
  const child = spawnSync(helper!, ["--gateway-tls-material"], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never include the helper output in assertion diagnostics.
  assert(child.status === 0 && !child.error, "The private-pipe helper must complete.");
  assert(child.stderr.length === 0, "The helper must not write diagnostics.");
  try {
    return JSON.parse(child.stdout.toString("utf8")) as Material;
  } catch {
    throw new Error("The helper did not return its JSON contract.");
  } finally {
    child.stdout.fill(0);
    child.stderr.fill(0);
  }
}

async function exchange(serverMaterial: Material, client: tls.ConnectionOptions): Promise<boolean> {
  const sockets = new Set<Socket>();
  const server = tls.createServer(
    {
      cert: serverMaterial.serverCertificate,
      key: serverMaterial.serverPrivateKey,
      ca: serverMaterial.caCertificate,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => socket.end("authenticated"),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return await new Promise<boolean>((resolve) => {
      const socket = tls.connect({
        ...client,
        host: "127.0.0.1",
        servername: "localhost",
        port: address.port,
        rejectUnauthorized: true,
      });
      let received = "";
      const deadline = setTimeout(() => socket.destroy(), 5_000);
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.length > 64) socket.destroy();
      });
      socket.on("error", () => {});
      socket.once("close", () => {
        clearTimeout(deadline);
        resolve(received === "authenticated" && socket.authorized);
      });
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("gateway helper pipe returns only matching leaf keys and the session CA", options, () => {
  const value = material();
  assert.deepEqual(Object.keys(value).sort(), [
    "caCertificate",
    "clientCertificate",
    "clientPrivateKey",
    "schemaVersion",
    "serverCertificate",
    "serverPrivateKey",
  ]);
  assert.equal(value.schemaVersion, 1);
  const ca = new X509Certificate(value.caCertificate);
  const server = new X509Certificate(value.serverCertificate);
  const client = new X509Certificate(value.clientCertificate);
  assert(ca.ca && !server.ca && !client.ca);
  assert(server.verify(ca.publicKey) && client.verify(ca.publicKey));
  assert(server.checkPrivateKey(createPrivateKey(value.serverPrivateKey)));
  assert(client.checkPrivateKey(createPrivateKey(value.clientPrivateKey)));
  assert.equal(server.checkHost("localhost"), "localhost");
  assert.equal(server.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(server.checkIP("::1"), "::1");
  assert.equal(server.checkHost("example.com"), undefined);
  assert.match(client.subject, /(?:^|\n)OU=openshell-user(?:\n|$)/u);
});

test("gateway helper certificates interoperate with Node TLS", options, async () => {
  const value = material();
  assert(
    await exchange(value, {
      ca: value.caCertificate,
      cert: value.clientCertificate,
      key: value.clientPrivateKey,
    }),
  );
});

test("gateway helper certificates reject a different session on either side", options, async () => {
  const value = material();
  const other = material();
  assert(
    !(await exchange(value, {
      ca: value.caCertificate,
      cert: other.clientCertificate,
      key: other.clientPrivateKey,
    })),
  );
  assert(
    !(await exchange(value, {
      ca: other.caCertificate,
      cert: value.clientCertificate,
      key: value.clientPrivateKey,
    })),
  );
});

test(
  "gateway helper server certificate cannot be used as a client certificate",
  options,
  async () => {
    const value = material();
    assert(
      !(await exchange(value, {
        ca: value.caCertificate,
        cert: value.serverCertificate,
        key: value.serverPrivateKey,
      })),
    );
  },
);

test("gateway helper TLS fixture rejects clients without certificates", options, async () => {
  const value = material();
  assert(!(await exchange(value, { ca: value.caCertificate })));
});

test("gateway helper refuses disk stdout and unsupported arguments without output", options, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-control-"));
  const output = path.join(root, "output");
  const descriptor = fs.openSync(output, "wx", 0o600);
  try {
    const child = spawnSync(helper!, ["--gateway-tls-material"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", descriptor, "pipe"],
    });
    assert(child.status === 2 && !child.error);
    assert(child.stderr.length === 0);
    assert.equal(fs.fstatSync(descriptor).size, 0);
    const invalid = spawnSync(helper!, ["--gateway-tls-material", "unexpected"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(invalid.status === 2 && !invalid.error);
    assert(invalid.stdout.length === 0 && invalid.stderr.length === 0);
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
