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

export const SQLITE_PAIRING_FIXTURE_SCRIPT = String.raw`
import json
import os
import sqlite3
import sys

state_dir = sys.argv[1]
value = json.load(sys.stdin)
os.umask(0o007)
sqlite_state_dir = os.path.join(state_dir, 'state')
os.makedirs(sqlite_state_dir, mode=0o770, exist_ok=True)
database = os.path.join(sqlite_state_dir, 'openclaw.sqlite')
connection = sqlite3.connect(database)
connection.execute('PRAGMA journal_mode = WAL')
connection.execute('PRAGMA wal_autocheckpoint = 0')
connection.executescript('''
CREATE TABLE device_identities (
  identity_key TEXT PRIMARY KEY, device_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE device_pairing_paired (
  device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, display_name TEXT,
  operator_label TEXT, platform TEXT, device_family TEXT, client_id TEXT, client_mode TEXT,
  browser_origin TEXT, role TEXT, roles_json TEXT, scopes_json TEXT,
  approved_scopes_json TEXT, remote_ip TEXT, tokens_json TEXT, approved_via TEXT,
  node_surface_json TEXT, pending_node_surface_json TEXT, created_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER, last_seen_reason TEXT
);
CREATE TABLE device_pairing_pending (
  request_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, public_key TEXT NOT NULL,
  display_name TEXT, platform TEXT, device_family TEXT, client_id TEXT, client_mode TEXT,
  browser_origin TEXT, role TEXT, roles_json TEXT, scopes_json TEXT, remote_ip TEXT,
  silent INTEGER, is_repair INTEGER, ts INTEGER NOT NULL, refreshed_at_ms INTEGER
);
CREATE TABLE device_auth_tokens (
  device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, role)
);
''')
connection.execute(f"PRAGMA user_version = {value.get('userVersion', 15)}")
connection.execute(
  'INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)',
  ('primary', value['deviceId'], value['publicKeyPem'], value['privateKeyPem'], 1, 1),
)
operator = {
  'operator': {
    'token': value['token'],
    'role': 'operator',
    'scopes': value['pairedTokenScopes'],
  },
}
connection.execute(
  'INSERT INTO device_pairing_paired VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  (
    value['deviceId'], value['publicKey'], None, None, None, None, value.get('clientId', 'cli'), value.get('clientMode', 'cli'), None,
    'operator', json.dumps(['operator']), json.dumps(value['pairedScopes']),
    json.dumps(value['pairedScopes']), None, json.dumps(operator), None, None, None,
    1, 1, None, None,
  ),
)
connection.execute(
  'INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)',
  (value['deviceId'], 'operator', value['token'], json.dumps(value['authScopes']), 1),
)
for request in value.get('pending') or []:
  connection.execute(
    'INSERT INTO device_pairing_pending VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (
      request['requestId'], request['deviceId'], request['publicKey'], None, None, None,
      request.get('clientId'), request.get('clientMode'), None, request.get('role'),
      json.dumps(request['roles']) if 'roles' in request else None,
      json.dumps(request['scopes']) if 'scopes' in request else None,
      None, None, int(request['isRepair']) if 'isRepair' in request else None, 1, None,
    ),
  )
connection.commit()
os._exit(0)
`;
