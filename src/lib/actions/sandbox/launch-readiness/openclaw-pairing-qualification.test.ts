// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
  readOpenClawPairingStateModule,
} from "../auto-pair-approval";
import {
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingQualification,
  observeOpenClawPairingRepairSettlement,
  observeOpenClawPairingSettlement,
  observeOrdinaryOpenClawPairingSettlement,
  OpenClawPairingObservationRetryableError,
  OpenClawPairingQualificationError,
  OPENCLAW_PAIRING_REQUEST_SCOPES,
  OPENCLAW_PAIRING_REQUIRED_SCOPES,
  parseOpenClawPairingObservation,
  parseOpenClawPairingRepairObservation,
  parseOpenClawPairingSettlementObservation,
} from "./openclaw-pairing-qualification";

const TOKEN = "credential-value-must-not-leave-the-sandbox";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PYTHON3_AVAILABLE =
  spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;
const OPENSSL_ED25519_AVAILABLE =
  spawnSync("/usr/bin/openssl", ["pkey", "-pubout", "-outform", "DER"], {
    input: generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    stdio: ["pipe", "ignore", "ignore"],
  }).status === 0;
type PairedFixture = Record<
  string,
  {
    deviceId: string;
    publicKey: string;
    scopes: string[];
    approvedScopes: string[];
    tokens: { operator: { token: string; scopes: string[] } };
    [key: string]: unknown;
  }
>;
type AuthFixture = {
  tokens: { operator: { token: string; scopes: string[] } };
};
const POLICY = `
ALLOWED_CLIENTS = {'cli', 'openclaw-cli', 'openclaw-control-ui'}
ALLOWED_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}
def approval_request_decision(device):
    client_id = str(device.get('clientId', ''))
    scopes = device.get('scopes', device.get('requestedScopes', []))
    if not isinstance(scopes, list):
        return {'allowed': False, 'reason': 'malformed-scopes'}
    return {
        'allowed': client_id in ALLOWED_CLIENTS and set(scopes).issubset(ALLOWED_SCOPES),
        'reason': 'allowlisted' if client_id in ALLOWED_CLIENTS else 'unknown-client',
    }
`;

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o660 });
  fs.chmodSync(filePath, 0o660);
}

function publicKeyPem(prefix: Buffer, key: Buffer): string {
  return `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([prefix, key]).toString("base64")}\n-----END PUBLIC KEY-----\n`;
}

function writeSqlitePairingState(
  stateDirectory: string,
  fixture: {
    deviceId: string;
    publicKey: string;
    privateKeyPem: string;
    token?: string;
    scopes?: readonly string[];
    pairedScopes?: readonly string[];
    pairedTokenScopes?: readonly string[];
    authScopes?: readonly string[];
    pending?: Record<string, unknown>[];
    userVersion?: number;
  },
): void {
  const scopes = fixture.scopes ?? OPENCLAW_PAIRING_REQUIRED_SCOPES;
  const token = fixture.token ?? TOKEN;
  const pairedScopes =
    fixture.pairedScopes ??
    (scopes.length === 1 ? ["operator.pairing"] : [...OPENCLAW_PAIRING_REQUEST_SCOPES]);
  const pairedTokenScopes = fixture.pairedTokenScopes ?? scopes;
  const authScopes = fixture.authScopes ?? scopes;
  const payload = {
    ...fixture,
    pairedScopes,
    pairedTokenScopes,
    authScopes,
    scopes,
    token,
    publicKeyPem: publicKeyPem(ED25519_SPKI_PREFIX, Buffer.from(fixture.publicKey, "base64url")),
  };
  const result = spawnSync("python3", ["-c", SQLITE_FIXTURE_SCRIPT, stateDirectory], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  expect(result.status, `failed to write SQLite pairing fixture: ${result.stderr}`).toBe(0);
  const database = path.join(stateDirectory, "state", "openclaw.sqlite");
  fs.chmodSync(database, 0o660);
  const wal = fs.statSync(`${database}-wal`);
  const sharedMemory = fs.statSync(`${database}-shm`);
  expect([wal.isFile(), wal.nlink, wal.gid, wal.mode & 0o007, wal.size > 0]).toEqual([
    true,
    1,
    process.getegid!(),
    0,
    true,
  ]);
  expect([
    sharedMemory.isFile(),
    sharedMemory.nlink,
    sharedMemory.gid,
    sharedMemory.mode & 0o007,
    sharedMemory.size > 0,
  ]).toEqual([true, 1, process.getegid!(), 0, true]);
}

function updateSqlitePairingState(stateDirectory: string, statement: string): void {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()",
      path.join(stateDirectory, "state", "openclaw.sqlite"),
      statement,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `failed to update SQLite pairing fixture: ${result.stderr}`).toBe(0);
}

function checkpointSqlitePairingState(stateDirectory: string): string {
  const database = path.join(stateDirectory, "state", "openclaw.sqlite");
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()",
      database,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `failed to checkpoint SQLite pairing fixture: ${result.stderr}`).toBe(0);
  expect([...fs.readFileSync(database).subarray(18, 20)]).toEqual([2, 2]);
  expect(fs.existsSync(`${database}-wal`)).toBe(false);
  expect(fs.existsSync(`${database}-shm`)).toBe(false);
  return database;
}

const SQLITE_FIXTURE_SCRIPT = String.raw`
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
    value['deviceId'], value['publicKey'], None, None, None, None, 'cli', 'cli', None,
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

function localScriptSpawn(
  _binary: string,
  _args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
) {
  const result = spawnSync("sh", ["-s"], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

describe("OpenClaw launch-readiness pairing qualification", () => {
  let root: string;
  let stateDirectory: string;
  let deviceId: string;
  let publicKey: string;
  let privateKeyPem: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-qualification-"));
    stateDirectory = path.join(root, ".openclaw");
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
    publicKey = publicKeyBytes.toString("base64url");
    deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
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
    performance.clearMeasures("nemoclaw.openclaw-pairing.qualification");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function observe(approvalPolicy = POLICY) {
    return observeOpenClawPairingQualification(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  function observeSettlement(approvalPolicy = POLICY) {
    return observeOpenClawPairingSettlement("alpha", "nemoclaw-8080", "2026.7.1", stateDirectory, {
      getOpenshellBinary: () => "openshell",
      readApprovalPolicy: () => approvalPolicy,
      spawnSync: localScriptSpawn as typeof spawnSync,
    });
  }

  function observeOrdinarySettlement(approvalPolicy = POLICY) {
    return observeOrdinaryOpenClawPairingSettlement(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  function observeRepairSettlement(approvalPolicy = POLICY) {
    return observeOpenClawPairingRepairSettlement(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  it("embeds the same packaged versioned pairing-state adapter as auto-pair approval", () => {
    const adapter = readOpenClawPairingStateModule();
    expect(adapter).toContain("ADAPTER_VERSION = 1");
    expect(
      buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      ),
    ).toContain(adapter);
    expect(
      buildAutoPairApprovalScript(Buffer.from(POLICY, "utf8").toString("base64"), {
        localDeviceOnly: true,
      }),
    ).toContain(adapter);
  });

  function writePairingOnlyState(): void {
    const pairedPath = path.join(stateDirectory, "devices", "paired.json");
    const authPath = path.join(stateDirectory, "identity", "device-auth.json");
    const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
    paired[deviceId]!.scopes = ["operator.pairing"];
    paired[deviceId]!.approvedScopes = ["operator.pairing"];
    paired[deviceId]!.tokens.operator.scopes = ["operator.pairing"];
    writeJson(pairedPath, paired);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
    auth.tokens.operator.scopes = ["operator.pairing"];
    writeJson(authPath, auth);
  }

  describe.skipIf(!PYTHON3_AVAILABLE)("state observation", () => {
    const sqliteIt = it.skipIf(!OPENSSL_ED25519_AVAILABLE);

    it("rejects a database swapped only while sqlite3.connect reopens its pathname", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      const databasePath = checkpointSqlitePairingState(stateDirectory);
      const attackerPath = path.join(root, "attacker.sqlite");
      fs.copyFileSync(databasePath, attackerPath);
      fs.chmodSync(attackerPath, 0o660);
      const validatedIdentity = fs.statSync(databasePath);
      const originalScript = buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      );
      const connect =
        "        connection = sqlite3.connect(database_uri, uri=True, timeout=timeout)";
      const attack = [
        "        validated_path = database_path + '.validated'",
        "        os.rename(database_path, validated_path)",
        `        os.rename(${JSON.stringify(attackerPath)}, database_path)`,
        connect,
        `        os.rename(database_path, ${JSON.stringify(attackerPath)})`,
        "        os.rename(validated_path, database_path)",
      ].join("\n");
      const script = originalScript.replace(connect, attack);
      expect(script).not.toBe(originalScript);

      const result = spawnSync("sh", ["-s"], {
        encoding: "utf8",
        env: process.env,
        input: script,
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(3);
      const restoredIdentity = fs.statSync(databasePath);
      expect([restoredIdentity.dev, restoredIdentity.ino]).toEqual([
        validatedIdentity.dev,
        validatedIdentity.ino,
      ]);
      expect(fs.existsSync(`${databasePath}.validated`)).toBe(false);
    });

    it("rejects WAL and SHM swapped only while SQLite performs its first read", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      const databasePath = path.join(stateDirectory, "state", "openclaw.sqlite");
      const walPath = `${databasePath}-wal`;
      const sharedMemoryPath = `${databasePath}-shm`;
      const attackerWalPath = path.join(root, "attacker.sqlite-wal");
      const attackerSharedMemoryPath = path.join(root, "attacker.sqlite-shm");
      fs.copyFileSync(walPath, attackerWalPath);
      fs.copyFileSync(sharedMemoryPath, attackerSharedMemoryPath);
      fs.chmodSync(attackerWalPath, 0o660);
      fs.chmodSync(attackerSharedMemoryPath, 0o660);
      const walIdentity = fs.statSync(walPath);
      const sharedMemoryIdentity = fs.statSync(sharedMemoryPath);
      const originalScript = buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      );
      const schemaRead =
        '        schema_version = connection.execute("PRAGMA user_version").fetchone()';
      const attack = [
        "        os.rename(database_path + '-wal', database_path + '-wal.validated')",
        "        os.rename(database_path + '-shm', database_path + '-shm.validated')",
        `        os.rename(${JSON.stringify(attackerWalPath)}, database_path + '-wal')`,
        `        os.rename(${JSON.stringify(attackerSharedMemoryPath)}, database_path + '-shm')`,
        schemaRead,
        `        os.rename(database_path + '-wal', ${JSON.stringify(attackerWalPath)})`,
        `        os.rename(database_path + '-shm', ${JSON.stringify(attackerSharedMemoryPath)})`,
        "        os.rename(database_path + '-wal.validated', database_path + '-wal')",
        "        os.rename(database_path + '-shm.validated', database_path + '-shm')",
      ].join("\n");
      const script = originalScript.replace(schemaRead, attack);
      expect(script).not.toBe(originalScript);

      const result = spawnSync("sh", ["-s"], {
        encoding: "utf8",
        env: process.env,
        input: script,
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(3);
      const restoredWalIdentity = fs.statSync(walPath);
      const restoredSharedMemoryIdentity = fs.statSync(sharedMemoryPath);
      expect([restoredWalIdentity.dev, restoredWalIdentity.ino]).toEqual([
        walIdentity.dev,
        walIdentity.ino,
      ]);
      expect([restoredSharedMemoryIdentity.dev, restoredSharedMemoryIdentity.ino]).toEqual([
        sharedMemoryIdentity.dev,
        sharedMemoryIdentity.ino,
      ]);
    });

    sqliteIt(
      "qualifies committed WAL state without consulting legacy JSON or mutating DB/WAL",
      () => {
        writeSqlitePairingState(stateDirectory, {
          deviceId,
          publicKey,
          privateKeyPem,
        });
        const database = path.join(stateDirectory, "state", "openclaw.sqlite");
        const walProof = spawnSync(
          "python3",
          [
            "-c",
            "import sqlite3,sys; p=sys.argv[1]; assert sqlite3.connect(f'file:{p}?immutable=1', uri=True).execute(\"SELECT COUNT(*) FROM sqlite_master WHERE name='device_identities'\").fetchone()[0] == 0; assert sqlite3.connect(f'file:{p}?mode=ro', uri=True).execute('SELECT COUNT(*) FROM device_identities').fetchone()[0] == 1",
            database,
          ],
          { encoding: "utf8" },
        );
        expect(walProof.status, walProof.stderr).toBe(0);
        writeJson(path.join(stateDirectory, "devices", "paired.json"), {});
        writeJson(path.join(stateDirectory, "identity", "device-auth.json"), {});
        const sqliteStateDirectory = path.dirname(database);
        const walPath = `${database}-wal`;
        const databaseBefore = fs.readFileSync(database);
        const walBefore = fs.readFileSync(walPath);
        const entriesBefore = fs.readdirSync(sqliteStateDirectory).sort();

        expect(observe()).toMatchObject({
          requiredRoles: ["operator"],
          requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        });
        expect(observeSettlement()).toEqual({
          state: "settled",
          deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(fs.readFileSync(database)).toEqual(databaseBefore);
        expect(fs.readFileSync(walPath)).toEqual(walBefore);
        expect(fs.readdirSync(sqliteStateDirectory).sort()).toEqual(entriesBefore);
      },
    );

    sqliteIt("qualifies the exact persisted admin-upgraded CLI state", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
        pairedScopes: ["operator.admin", "operator.pairing", "operator.write"],
        pairedTokenScopes: [
          "operator.admin",
          "operator.pairing",
          "operator.read",
          "operator.write",
        ],
        authScopes: ["operator.admin", "operator.read", "operator.write"],
      });

      expect(observeSettlement()).toMatchObject({ state: "settled" });
    });

    it("rejects an unsupported authoritative SQLite schema version", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
        userVersion: 14,
      });
      const database = checkpointSqlitePairingState(stateDirectory);

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
      expect(fs.existsSync(`${database}-shm`)).toBe(false);
    });

    it("rejects invalid native identity timestamps", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      updateSqlitePairingState(stateDirectory, "UPDATE device_identities SET created_at_ms = -1");

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    sqliteIt("rejects a private identity key that does not match the canonical public key", () => {
      const mismatchedPrivateKey = generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
      });
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem: mismatchedPrivateKey.toString(),
      });

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    sqliteIt("treats an unavailable OpenSSL binary as a terminal qualification failure", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      const spawnWithoutOpenSsl = (
        _binary: string,
        _args: readonly string[],
        options: Parameters<typeof spawnSync>[2],
      ) => {
        return localScriptSpawn("sh", ["-s"], {
          ...options,
          input: String(options?.input).replace(
            "openssl = '/usr/bin/openssl'",
            "openssl = '/definitely-missing/nemoclaw-openssl'",
          ),
        });
      };

      let failure: unknown;
      try {
        observeOpenClawPairingQualification("alpha", "nemoclaw-8080", "2026.7.1", stateDirectory, {
          getOpenshellBinary: () => "openshell",
          readApprovalPolicy: () => POLICY,
          spawnSync: spawnWithoutOpenSsl as typeof spawnSync,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenClawPairingQualificationError);
      expect(failure).not.toBeInstanceOf(OpenClawPairingObservationRetryableError);
    });

    it("retries a nonempty WAL without SHM instead of creating the missing sidecar", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      const sqliteStateDirectory = path.join(stateDirectory, "state");
      const sharedMemoryPath = path.join(sqliteStateDirectory, "openclaw.sqlite-shm");
      fs.rmSync(sharedMemoryPath);
      fs.writeFileSync(path.join(sqliteStateDirectory, "openclaw.sqlite-wal"), "pending-wal", {
        mode: 0o660,
      });

      expect(() => observe()).toThrow(OpenClawPairingObservationRetryableError);
      expect(fs.existsSync(sharedMemoryPath)).toBe(false);
    });

    sqliteIt("never falls back to valid legacy JSON after SQLite becomes authoritative", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
        token: `${TOKEN}-sqlite-mismatch`,
      });
      const database = path.join(stateDirectory, "state", "openclaw.sqlite");
      const result = spawnSync(
        "python3",
        [
          "-c",
          "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE device_auth_tokens SET token='different-token'\"); c.commit()",
          database,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("rejects an unsafe authoritative SQLite database instead of reading legacy state", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
      });
      fs.chmodSync(path.join(stateDirectory, "state", "openclaw.sqlite"), 0o666);

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("disables trusted schema and fences legacy selection after its second snapshot", () => {
      const script = buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      );
      const secondSnapshot = script.indexOf("second = read_snapshot()");
      const legacyFence = script.indexOf("assert_legacy_layout_current()", secondSnapshot);
      const projection = script.indexOf("identity = parse_json(first['identity'][0])");

      expect(script).toContain('connection.execute("PRAGMA trusted_schema = OFF")');
      expect(secondSnapshot).toBeGreaterThan(-1);
      expect(legacyFence).toBeGreaterThan(secondSnapshot);
      expect(projection).toBeGreaterThan(legacyFence);
    });

    sqliteIt("normalizes a canonical SQLite repair request into settlement state", () => {
      writeSqlitePairingState(stateDirectory, {
        deviceId,
        publicKey,
        privateKeyPem,
        scopes: ["operator.pairing"],
        pending: [
          {
            requestId: "canonical-cli-write",
            deviceId,
            publicKey,
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.write"],
            isRepair: true,
          },
        ],
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(observeRepairSettlement()).toEqual({
        state: "pairing-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("emits credential-free qualification from canonical settled OpenClaw state (#9023)", () => {
      const qualification = observe();
      const serialized = JSON.stringify(qualification);

      expect(qualification).toMatchObject({
        schemaVersion: 1,
        kind: "openclaw-pairing",
        openclawVersion: "2026.7.1",
        requiredRoles: ["operator"],
        requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pairingStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(privateKeyPem);
      expect(serialized).not.toContain(publicKey);
      expect(serialized).not.toContain(deviceId);
      expect(performance.getEntriesByName("nemoclaw.openclaw-pairing.qualification")).toHaveLength(
        1,
      );
    });

    it("strictly distinguishes settled and pairing-only state without exposing identity (#9207)", () => {
      const settled = observeSettlement();
      writePairingOnlyState();
      const pairingOnly = observeSettlement();

      expect(settled).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(pairingOnly).toEqual({
        state: "pairing-only",
        deviceIdentitySha256: settled.deviceIdentitySha256,
      });
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(TOKEN);
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(deviceId);
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(publicKey);
    });

    it("observes settlement without version provenance but keeps qualification version-bound (#9527)", () => {
      const deps = {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => POLICY,
        spawnSync: localScriptSpawn as typeof spawnSync,
      };

      expect(
        observeOpenClawPairingSettlement("alpha", "nemoclaw-8080", "", stateDirectory, deps),
      ).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() =>
        observeOpenClawPairingQualification("alpha", "nemoclaw-8080", "", stateDirectory, deps),
      ).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("accepts the exact canonical Ed25519 public-key PEM representation (#9207)", () => {
      const identityPath = path.join(stateDirectory, "identity", "device.json");
      writeJson(identityPath, {
        deviceId,
        publicKeyPem: publicKeyPem(ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64url")),
        privateKeyPem,
      });

      expect(observeSettlement()).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("rejects pending or non-exact scope state from Portable settlement (#9207)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "request-1": {
          requestId: "request-1",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
          isRepair: true,
        },
      });
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");

      writeJson(path.join(stateDirectory, "devices", "pending.json"), {});
      const pairedPath = path.join(stateDirectory, "devices", "paired.json");
      const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
      paired[deviceId]!.scopes = ["operator.pairing", "operator.read"];
      writeJson(pairedPath, paired);
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("ignores unrelated pending requests during ordinary onboarding (#9844)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        unrelated: {
          requestId: "unrelated",
          deviceId: "b".repeat(64),
          publicKey: "unrelated-public-key",
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("rejects malformed same-device pending requests during ordinary onboarding (#9844)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        related: {
          requestId: "related",
          deviceId,
          publicKey,
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });

      expect(() => observeOrdinarySettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("observes the exact canonical scope upgrade awaiting approval (#9817)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "canonical-cli-write": {
          requestId: "canonical-cli-write",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: true,
        },
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(observeRepairSettlement()).toEqual({
        state: "pairing-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");

      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        first: {
          requestId: "first",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: true,
        },
        second: {
          requestId: "second",
          deviceId: "b".repeat(64),
          publicKey: "unrelated-public-key",
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });
      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("classifies a canonical state file that is not visible yet as retryable (#9817)", () => {
      fs.rmSync(path.join(stateDirectory, "devices", "pending.json"));

      expect(() => observeRepairSettlement()).toThrow(OpenClawPairingObservationRetryableError);
    });

    it("keeps unrelated pending requests terminal instead of retrying them (#9817)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        unrelated: {
          requestId: "unrelated",
          deviceId: "b".repeat(64),
          publicKey: "unrelated-public-key",
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });

      let failure: unknown;
      try {
        observeRepairSettlement();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenClawPairingQualificationError);
      expect(failure).not.toBeInstanceOf(OpenClawPairingObservationRetryableError);
    });

    it("rejects a non-repair request from Portable repair settlement (#9817)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "canonical-cli-write": {
          requestId: "canonical-cli-write",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: false,
        },
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("qualifies the persisted result of the complete canonical approval transition (#9023)", () => {
      const approvalPolicy = readAutoPairApprovalPolicyModule();
      expect(approvalPolicy).toBeTruthy();
      const requestId = "canonical-cli-write";
      writeJson(path.join(stateDirectory, "identity", "device-auth.json"), {
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: TOKEN,
            role: "operator",
            scopes: ["operator.pairing"],
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
          scopes: ["operator.pairing"],
          approvedScopes: ["operator.pairing"],
          tokens: {
            operator: {
              token: TOKEN,
              role: "operator",
              scopes: ["operator.pairing"],
            },
          },
        },
      });
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        [requestId]: {
          requestId,
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
          isRepair: true,
        },
      });
      const openclawPath = path.join(root, "openclaw");
      fs.writeFileSync(
        openclawPath,
        `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] !== "devices" || args[1] !== "approve") process.exit(2);
const stateDir = process.env.NEMOCLAW_TEST_CLONE_STATE_DIR;
const pendingPath = path.join(stateDir, "devices", "pending.json");
const pairedPath = path.join(stateDir, "devices", "paired.json");
const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
const request = pending[args[2]];
delete pending[args[2]];
paired[request.deviceId] = {
  ...paired[request.deviceId],
  scopes: request.scopes,
  approvedScopes: request.scopes,
  tokens: {
    operator: {
      token: "rotated-canonical-token",
      role: "operator",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    },
  },
};
fs.writeFileSync(pendingPath, JSON.stringify(pending));
fs.writeFileSync(pairedPath, JSON.stringify(paired));
process.stdout.write("{}\\n");
`,
        { mode: 0o755 },
      );
      const approval = spawnSync("sh", {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${root}:/usr/bin:/bin`,
          NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
          NEMOCLAW_TEST_CLONE_STATE_DIR: stateDirectory,
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_STATE_DIR: stateDirectory,
        },
        input: buildAutoPairApprovalScript(
          Buffer.from(approvalPolicy as string, "utf8").toString("base64"),
          {
            emitReceipt: true,
            localDeviceOnly: true,
            budget: { maxApprovals: 1 },
          },
        ),
      });

      expect(approval.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(approval.stdout)).toBe("approved-one");
      expect(observe(approvalPolicy as string)).toMatchObject({
        requiredRoles: ["operator"],
        requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
      });
    });

    it("does not make paired credential values part of the receipt identity (#9023)", () => {
      const first = observe();
      const pairedPath = path.join(stateDirectory, "devices", "paired.json");
      const authPath = path.join(stateDirectory, "identity", "device-auth.json");
      const replacementToken = `${TOKEN}-rotated`;
      const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
      paired[deviceId]!.tokens.operator.token = replacementToken;
      writeJson(pairedPath, paired);
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
      auth.tokens.operator.token = replacementToken;
      writeJson(authPath, auth);

      const second = observe();

      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toContain(replacementToken);
    });

    it("does not derive pairing evidence from arbitrary OpenClaw configuration (#9023)", () => {
      const first = observe();
      const credentialValue = `${TOKEN}-arbitrary-config`;
      writeJson(path.join(stateDirectory, "openclaw.json"), {
        unknown: {
          privateKeyPem: credentialValue,
          passwordValue: credentialValue,
          credentialValue,
          headers: { Authorization: `Bearer ${credentialValue}` },
          url: `https://user:${credentialValue}@example.invalid/path?token=${credentialValue}`,
          args: ["run", credentialValue],
        },
      });

      const second = observe();
      const serialized = JSON.stringify(second);

      expect(second).toEqual(first);
      expect(serialized).not.toContain(credentialValue);
    });

    it("rejects a new allowlisted pending request without calling the OpenClaw CLI (#9023)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "request-1": {
          requestId: "request-1",
          clientId: "cli",
          clientMode: "cli",
          scopes: ["operator.write"],
        },
      });

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
      const script = buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      );
      expect(script).not.toContain("openclaw devices list");
      expect(script).not.toContain("[OPENCLAW, 'devices', 'list'");
    });

    it.each([
      [
        "malformed pending state",
        () => writeJson(path.join(stateDirectory, "devices", "pending.json"), []),
      ],
      [
        "unsafe paired permissions",
        () => fs.chmodSync(path.join(stateDirectory, "devices", "paired.json"), 0o666),
      ],
      [
        "world-readable device credentials",
        () => fs.chmodSync(path.join(stateDirectory, "identity", "device-auth.json"), 0o604),
      ],
      [
        "mismatched client credential",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.token = "different-token";
          writeJson(authPath, auth);
        },
      ],
      [
        "changed paired request scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.scopes = ["operator.pairing", "operator.read", "operator.write"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed approved request scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.approvedScopes = ["operator.pairing", "operator.read"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed paired token scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.tokens.operator.scopes = ["operator.pairing", "operator.write"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed client-auth token scopes",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.scopes = ["operator.pairing", "operator.write"];
          writeJson(authPath, auth);
        },
      ],
      [
        "changed canonical client ID",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.clientId = "unknown-client";
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed canonical client mode",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.clientMode = "unknown-mode";
          writeJson(pairedPath, paired);
        },
      ],
      [
        "duplicate operator identity roles",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.roles = ["operator", "operator"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "missing canonical operator role",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          delete (paired[deviceId]! as unknown as Record<string, unknown>).role;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "missing canonical operator roles",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          delete (paired[deviceId]! as unknown as Record<string, unknown>).roles;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "conflicting device public-key representations",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKeyPem = publicKeyPem(ED25519_SPKI_PREFIX, Buffer.alloc(32, 8));
          writeJson(identityPath, identity);
        },
      ],
      [
        "malformed public-key PEM with a matching suffix",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKeyPem = publicKeyPem(Buffer.alloc(12), Buffer.alloc(32, 7));
          writeJson(identityPath, identity);
        },
      ],
      [
        "noncanonical padded raw public key",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKey = `${publicKey}=`;
          writeJson(identityPath, identity);
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.publicKey = `${publicKey}=`;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "whitespace-padded operator token",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.tokens.operator.token = ` ${TOKEN} `;
          writeJson(pairedPath, paired);
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.token = ` ${TOKEN} `;
          writeJson(authPath, auth);
        },
      ],
      [
        "boolean client-auth schema version",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture & {
            version?: unknown;
          };
          auth.version = true;
          writeJson(authPath, auth);
        },
      ],
      [
        "alternate scopes on the paired device",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.requestedScopes = ["operator.admin"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate public key on the paired device",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.publicKeyPem = publicKeyPem(ED25519_SPKI_PREFIX, Buffer.alloc(32, 8));
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate roles on the paired operator token",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          (paired[deviceId]!.tokens.operator as unknown as Record<string, unknown>).roles = [
            "admin",
          ];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate scopes on the client authorization",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          (auth.tokens.operator as unknown as Record<string, unknown>).approvedScopes = [
            "operator.admin",
          ];
          writeJson(authPath, auth);
        },
      ],
      [
        "ambiguous local device state",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired.duplicate = {
            ...paired[deviceId]!,
            deviceId: "different-device",
          };
          writeJson(pairedPath, paired);
        },
      ],
    ])("rejects %s and requires the complete pairing path (#9023)", (_label, mutate) => {
      expect(() => observe()).not.toThrow();
      mutate();
      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });
  });

  it("pins observation to the named gateway and rejects non-terminal output (#9023)", () => {
    const digest = "a".repeat(64);
    const spawn = vi.fn(
      (_binary: string, _args: readonly string[], _options: Parameters<typeof spawnSync>[2]) => ({
        status: 0,
        signal: null,
        stdout: `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
          deviceIdentitySha256: digest,
          pairingStateSha256: digest,
          requiredRoles: ["operator"],
          requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        })}\nuntrusted trailing output\n`,
        stderr: "",
      }),
    );

    expect(() =>
      observeOpenClawPairingQualification("alpha", "nemoclaw-8080", "2026.7.1", stateDirectory, {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => POLICY,
        spawnSync: spawn as never,
      }),
    ).toThrow("OpenClaw pairing qualification is unavailable");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8080",
      "--",
      "sh",
      "-s",
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      maxBuffer: 4 * 1_024,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3_000,
    });
  });

  it("transports state paths without shell interpretation (#9023)", () => {
    const rawStateDirectory = "/sandbox/state'$(touch should-not-run)";
    const script = buildOpenClawPairingObservationScript(
      Buffer.from(POLICY, "utf8").toString("base64"),
      rawStateDirectory,
    );

    expect(script).not.toContain(rawStateDirectory);
    expect(script).toContain(Buffer.from(rawStateDirectory, "utf8").toString("base64"));
  });

  it("rejects extra receipt fields that could carry unrestricted state (#9023)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
      deviceIdentitySha256: digest,
      pairingStateSha256: digest,
      requiredRoles: ["operator"],
      requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
      token: TOKEN,
    })}\n`;

    expect(parseOpenClawPairingObservation(output)).toBeNull();
  });

  it("rejects non-terminal or expanded Portable settlement output (#9207)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "settled",
      deviceIdentitySha256: digest,
      requestId: "secret-request",
    })}\n`;
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
    expect(
      parseOpenClawPairingSettlementObservation(
        `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
          state: "settled",
          deviceIdentitySha256: digest,
        })}\ntrailing\n`,
      ),
    ).toBeNull();
  });

  it("keeps canonical pending state outside strict Portable settlement (#9817)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    })}\n`;

    expect(parseOpenClawPairingRepairObservation(output)).toEqual({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    });
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
  });
});
