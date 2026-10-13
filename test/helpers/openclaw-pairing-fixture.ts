// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCLAW_PAIRING_REQUIRED_SCOPES,
  OPENCLAW_PAIRING_REQUEST_SCOPES,
} from "../../src/lib/actions/sandbox/launch-readiness/openclaw-pairing-qualification";

export function createOpenClawPairingFixture() {
  const TOKEN = "credential-value-must-not-leave-the-sandbox";
  const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const writeJson = (file: string, value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o660 });
    fs.chmodSync(file, 0o660);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-qualification-"));
  let stateDirectory = path.join(root, ".openclaw");
  fs.mkdirSync(path.join(stateDirectory, "devices"), {
    mode: 0o2770,
    recursive: true,
  });
  fs.mkdirSync(path.join(stateDirectory, "identity"), {
    mode: 0o2770,
    recursive: true,
  });
  stateDirectory = fs.realpathSync(stateDirectory);
  fs.chmodSync(stateDirectory, 0o2770);
  fs.chmodSync(path.join(stateDirectory, "devices"), 0o2770);
  fs.chmodSync(path.join(stateDirectory, "identity"), 0o2770);
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({
    type: "spki",
    format: "der",
  });
  const publicKeyBytes = publicKeyDer.subarray(ED25519_SPKI_PREFIX.length);
  const publicKey = publicKeyBytes.toString("base64url");
  const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeJson(path.join(stateDirectory, "openclaw.json"), {
    gateway: { mode: "local", auth: { token: TOKEN } },
  });
  writeJson(path.join(stateDirectory, "identity", "device.json"), {
    deviceId,
    publicKey,
    privateKeyPem,
  });
  writeJson(path.join(stateDirectory, "identity", "device-auth.json"), {
    version: 1,
    deviceId,
    tokens: {
      operator: {
        token: TOKEN,
        role: "operator",
        scopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
      },
    },
  });
  writeJson(path.join(stateDirectory, "devices", "paired.json"), {
    [deviceId]: {
      deviceId,
      publicKey,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
      approvedScopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
      tokens: {
        operator: {
          token: TOKEN,
          role: "operator",
          scopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
        },
      },
    },
  });
  writeJson(path.join(stateDirectory, "devices", "pending.json"), {});
  return { root, stateDirectory, deviceId, publicKey, privateKeyPem };
}
