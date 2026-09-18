// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
  readOpenClawPairingStateModule,
} from "./auto-pair-approval";

describe("auto-pair approval SQLite compatibility", () => {
  const pyIt =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0 ? it : it.skip;
  const pyIt25s = (name: string, test: () => void) => pyIt(name, test, 25_000);

  it("embeds the packaged versioned pairing-state adapter", () => {
    const policy = readAutoPairApprovalPolicyModule();
    const adapter = readOpenClawPairingStateModule();
    expect(policy).toBeTruthy();
    expect(adapter).toContain("ADAPTER_VERSION = 1");
    const script = buildAutoPairApprovalScript(Buffer.from(policy as string).toString("base64"), {
      localDeviceOnly: true,
    });
    expect(script).toContain(adapter);
    expect(script).toContain("clone_state_dir_fd = _open_state_root(state_dir)");
    expect(script).toContain(
      "clone_database_dir_fd = _open_state_directory(state_dir, clone_state_dir_fd)",
    );
    expect(script).toContain("'openclaw.sqlite', _file_flags()");
    expect(script).toContain("sqlite_snapshot_is_current(");
    expect(script).toContain("local_device_only=True");
    expect(script).toContain(
      "SELECT * FROM device_pairing_paired WHERE device_id = ? ORDER BY device_id",
    );
    expect(script).toContain("clone_paired_snapshot_fd = open_clone_snapshot_descriptor({");
    expect(script).not.toContain("clone_directory_flags =");
    expect(script).not.toContain("clone_path_flags =");
    expect(script).not.toContain("clone_file_flags =");
    expect(script).not.toContain("def open_clone_state_root");
    expect(script).not.toContain("def clone_state_root_is_current");
    expect(script).not.toContain("open_clone_directory('state')");
    expect(script).not.toContain("clone_directory_is_current('state'");
  });

  function expectUnsafeCanonicalState(
    script: string,
    version: number,
    walContents: readonly string[] = [],
  ): void {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-db-reject-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const setup = spawnSync(
        "python3",
        [
          "-c",
          "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode = WAL'); c.execute(f'PRAGMA user_version = {sys.argv[2]}'); c.commit(); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()",
          databasePath,
          String(version),
        ],
        { encoding: "utf-8" },
      );
      expect(setup.status, setup.stderr).toBe(0);
      fs.chmodSync(databasePath, 0o660);
      expect([...fs.readFileSync(databasePath).subarray(18, 20)]).toEqual([2, 2]);
      expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
      fs.writeFileSync(path.join(tmpDir, "openclaw"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      for (const contents of walContents) {
        fs.writeFileSync(`${databasePath}-wal`, contents);
        fs.chmodSync(`${databasePath}-wal`, 0o660);
      }
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        parseAutoPairApprovalReceipt(result.stdout),
        `${result.stdout}\n${result.stderr}`,
      ).toBe("list-pending-unsafe");
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  pyIt25s("rejects a database swapped only while sqlite3.connect reopens its pathname", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const originalScript = buildAutoPairApprovalScript(
      Buffer.from(policy as string).toString("base64"),
      {
        emitSummary: true,
        emitReceipt: true,
        localDeviceOnly: true,
        budget: { maxApprovals: 1 },
      },
    );
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-db-aba-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const attackerPath = path.join(tmpDir, "attacker.sqlite");
      const bindingCheckpoint = path.join(tmpDir, "database-binding-accepted");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const setup = spawnSync(
        "python3",
        [
          "-c",
          "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=15'); c.commit(); c.close()",
          databasePath,
        ],
        { encoding: "utf-8" },
      );
      expect(setup.status, setup.stderr).toBe(0);
      fs.chmodSync(databasePath, 0o660);
      fs.copyFileSync(databasePath, attackerPath);
      fs.chmodSync(attackerPath, 0o660);
      const validatedIdentity = fs.statSync(databasePath);
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
      const postBinding = "        connection.row_factory = sqlite3.Row";
      const script = originalScript
        .replace(connect, attack)
        .replace(
          postBinding,
          `        open(${JSON.stringify(bindingCheckpoint)}, 'w').close()\n${postBinding}`,
        );
      expect(script).not.toBe(originalScript);
      expect(script).toContain(JSON.stringify(bindingCheckpoint));
      fs.writeFileSync(path.join(tmpDir, "openclaw"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const scriptPath = path.join(tmpDir, "auto-pair-approval.sh");
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync("sh", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(
        parseAutoPairApprovalReceipt(result.stdout),
        `${result.stdout}\n${result.stderr}`,
      ).toBe("list-pending-unsafe");
      const restoredIdentity = fs.statSync(databasePath);
      expect([restoredIdentity.dev, restoredIdentity.ino]).toEqual([
        validatedIdentity.dev,
        validatedIdentity.ino,
      ]);
      expect(fs.existsSync(`${databasePath}.validated`)).toBe(false);
      expect(fs.existsSync(bindingCheckpoint)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  pyIt25s("rejects WAL and SHM swapped only while SQLite performs its first read", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const originalScript = buildAutoPairApprovalScript(
      Buffer.from(policy as string).toString("base64"),
      {
        emitSummary: true,
        emitReceipt: true,
        localDeviceOnly: true,
        budget: { maxApprovals: 1 },
      },
    );
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wal-aba-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const setup = spawnSync(
        "python3",
        [
          "-c",
          "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA wal_autocheckpoint=0'); c.execute('CREATE TABLE state(value TEXT)'); c.execute('PRAGMA user_version=15'); c.commit(); os._exit(0)",
          databasePath,
        ],
        { encoding: "utf-8" },
      );
      expect(setup.status, setup.stderr).toBe(0);
      fs.chmodSync(databasePath, 0o660);
      const walPath = `${databasePath}-wal`;
      const sharedMemoryPath = `${databasePath}-shm`;
      const attackerWalPath = path.join(tmpDir, "attacker.sqlite-wal");
      const attackerSharedMemoryPath = path.join(tmpDir, "attacker.sqlite-shm");
      const bindingCheckpoint = path.join(tmpDir, "sidecar-binding-accepted");
      fs.copyFileSync(walPath, attackerWalPath);
      fs.copyFileSync(sharedMemoryPath, attackerSharedMemoryPath);
      fs.chmodSync(attackerWalPath, 0o660);
      fs.chmodSync(attackerSharedMemoryPath, 0o660);
      const walIdentity = fs.statSync(walPath);
      const sharedMemoryIdentity = fs.statSync(sharedMemoryPath);
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
      const postBinding =
        "        if schema_version is None or schema_version[0] != OPENCLAW_STATE_SCHEMA_VERSION:";
      const script = originalScript
        .replace(schemaRead, attack)
        .replace(
          postBinding,
          `        open(${JSON.stringify(bindingCheckpoint)}, 'w').close()\n${postBinding}`,
        );
      expect(script).not.toBe(originalScript);
      expect(script).toContain(JSON.stringify(bindingCheckpoint));
      fs.writeFileSync(path.join(tmpDir, "openclaw"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const scriptPath = path.join(tmpDir, "auto-pair-approval.sh");
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync("sh", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(parseAutoPairApprovalReceipt(result.stdout)).toBe("list-pending-unsafe");
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
      expect(fs.existsSync(bindingCheckpoint)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  pyIt25s("uses canonical SQLite snapshots without recreating legacy device state", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(Buffer.from(policy as string).toString("base64"), {
      emitSummary: true,
      emitReceipt: true,
      localDeviceOnly: true,
      budget: { maxApprovals: 1 },
    });
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-pair-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const databaseDir = path.join(stateDir, "state");
      const databasePath = path.join(databaseDir, "openclaw.sqlite");
      const approveCallsFile = path.join(tmpDir, "approve-calls.log");
      fs.mkdirSync(databaseDir, { recursive: true });
      const legacyIdentityDir = path.join(stateDir, "identity");
      const legacyDevicesDir = path.join(stateDir, "devices");
      fs.mkdirSync(legacyIdentityDir);
      fs.mkdirSync(legacyDevicesDir);
      const staleLegacyFiles = new Map([
        [path.join(legacyIdentityDir, "device.json"), "stale legacy identity\n"],
        [path.join(legacyIdentityDir, "device-auth.json"), "stale legacy auth\n"],
        [path.join(legacyDevicesDir, "pending.json"), "stale legacy pending\n"],
        [path.join(legacyDevicesDir, "paired.json"), "stale legacy paired\n"],
      ]);
      for (const [file, content] of staleLegacyFiles) {
        fs.writeFileSync(file, content);
      }
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      const publicKeyText = publicKeyRaw.toString("base64url");
      const deviceId = crypto.createHash("sha256").update(publicKeyRaw).digest("hex");
      const requestId = "sqlite-upgrade-1";
      const beforeToken = "sqlite-before-token";
      const afterToken = "sqlite-after-token";
      const unrelatedDeviceId = "unrelated-device";
      const unrelatedToken = "unrelated-token-must-not-reach-approval-child";
      const fixture = {
        deviceId,
        publicKeyPem,
        privateKeyPem,
        publicKeyText,
        requestId,
        beforeToken,
        unrelatedDeviceId,
        unrelatedToken,
      };
      const setup = spawnSync(
        "python3",
        [
          "-c",
          `import json, os, sqlite3, sys
db, raw = sys.argv[1:]
f = json.loads(raw)
os.umask(0o007)
c = sqlite3.connect(db)
c.execute('PRAGMA journal_mode = WAL')
c.execute('PRAGMA wal_autocheckpoint = 0')
c.executescript('''
CREATE TABLE device_identities (identity_key TEXT PRIMARY KEY, device_id TEXT, public_key_pem TEXT, private_key_pem TEXT, created_at_ms INTEGER, updated_at_ms INTEGER);
CREATE TABLE device_pairing_pending (request_id TEXT PRIMARY KEY, device_id TEXT, public_key TEXT, display_name TEXT, platform TEXT, device_family TEXT, client_id TEXT, client_mode TEXT, browser_origin TEXT, role TEXT, roles_json TEXT, scopes_json TEXT, remote_ip TEXT, silent INTEGER, is_repair INTEGER, ts INTEGER, refreshed_at_ms INTEGER);
CREATE TABLE device_pairing_paired (device_id TEXT PRIMARY KEY, public_key TEXT, display_name TEXT, operator_label TEXT, platform TEXT, device_family TEXT, client_id TEXT, client_mode TEXT, browser_origin TEXT, role TEXT, roles_json TEXT, scopes_json TEXT, approved_scopes_json TEXT, remote_ip TEXT, tokens_json TEXT, approved_via TEXT, node_surface_json TEXT, pending_node_surface_json TEXT, created_at_ms INTEGER, approved_at_ms INTEGER, last_seen_at_ms INTEGER, last_seen_reason TEXT);
CREATE TABLE device_auth_tokens (device_id TEXT, role TEXT, token TEXT, scopes_json TEXT, updated_at_ms INTEGER, PRIMARY KEY (device_id, role));
PRAGMA user_version = 15;
''')
c.execute('INSERT INTO device_identities VALUES (?,?,?,?,?,?)', ('primary', f['deviceId'], f['publicKeyPem'], f['privateKeyPem'], 1, 1))
c.execute('INSERT INTO device_pairing_pending VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (f['requestId'], f['deviceId'], f['publicKeyText'], None, None, None, 'cli', 'cli', None, 'operator', json.dumps(['operator']), json.dumps(['operator.write']), None, 0, 1, 1, None))
tokens = {'operator': {'token': f['beforeToken'], 'role': 'operator', 'scopes': ['operator.pairing']}}
c.execute('INSERT INTO device_pairing_paired VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (f['deviceId'], f['publicKeyText'], None, None, None, None, 'cli', 'cli', None, 'operator', json.dumps(['operator']), json.dumps(['operator.pairing']), json.dumps(['operator.pairing']), None, json.dumps(tokens), None, None, None, 1, 1, None, None))
c.execute('INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)', (f['deviceId'], 'operator', f['beforeToken'], json.dumps(['operator.pairing']), 1))
unrelated_tokens = {'operator': {'token': f['unrelatedToken'], 'role': 'operator', 'scopes': ['operator.pairing']}}
c.execute('INSERT INTO device_pairing_paired VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (f['unrelatedDeviceId'], 'unrelated-public-key', None, None, None, None, 'cli', 'cli', None, 'operator', json.dumps(['operator']), json.dumps(['operator.pairing']), json.dumps(['operator.pairing']), None, json.dumps(unrelated_tokens), None, None, None, 1, 1, None, None))
c.execute('INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)', (f['unrelatedDeviceId'], 'operator', f['unrelatedToken'], json.dumps(['operator.pairing']), 1))
c.commit()
os._exit(0)
`,
          databasePath,
          JSON.stringify(fixture),
        ],
        { encoding: "utf-8" },
      );
      expect(setup.status, setup.stderr).toBe(0);
      const wal = fs.statSync(`${databasePath}-wal`);
      const sharedMemory = fs.statSync(`${databasePath}-shm`);
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
      const walProof = spawnSync(
        "python3",
        [
          "-c",
          "import sqlite3,sys; p=sys.argv[1]; assert sqlite3.connect(f'file:{p}?immutable=1', uri=True).execute(\"SELECT COUNT(*) FROM sqlite_master WHERE name='device_identities'\").fetchone()[0] == 0; assert sqlite3.connect(f'file:{p}?mode=ro', uri=True).execute('SELECT COUNT(*) FROM device_identities').fetchone()[0] == 1",
          databasePath,
        ],
        { encoding: "utf-8" },
      );
      expect(walProof.status, walProof.stderr).toBe(0);
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!/usr/bin/env python3
import json, os, sqlite3, sys
args = sys.argv[1:]
if args[:2] != ['devices', 'approve']:
    sys.exit(2)
def descriptor(name):
    raw = os.environ.get(name, '')
    if not raw.isdecimal() or int(raw) < 3:
        raise RuntimeError('descriptor unavailable')
    metadata = os.fstat(int(raw))
    if not os.path.isfile('/dev/fd/' + raw) or metadata.st_nlink != 0:
        raise RuntimeError('descriptor unsafe')
    with os.fdopen(os.dup(int(raw)), encoding='utf-8') as handle:
        return json.load(handle)
identity = descriptor('NEMOCLAW_OPENCLAW_IDENTITY_FD')
pending = descriptor('NEMOCLAW_OPENCLAW_PENDING_FD')
paired = descriptor('NEMOCLAW_OPENCLAW_PAIRED_FD')
request = pending.get(args[2])
paired_device = paired.get(identity.get('deviceId'))
if (
    set(identity) != {'version', 'deviceId', 'publicKeyPem', 'privateKeyPem'}
    or request is None
    or paired_device is None
    or request.get('deviceId') != identity.get('deviceId')
    or os.environ.get('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING') != '1'
    or os.environ.get('OPENCLAW_GATEWAY_URL') != 'ws://127.0.0.1:18789'
    or os.environ.get('OPENCLAW_GATEWAY_TOKEN')
    or set(pending) != {args[2]}
    or set(paired) != {identity.get('deviceId')}
    or ${JSON.stringify(unrelatedToken)} in json.dumps({'identity': identity, 'pending': pending, 'paired': paired})
):
    sys.exit(3)
with open(${JSON.stringify(approveCallsFile)}, 'a', encoding='utf-8') as handle:
    handle.write(args[2] + '\\n')
scopes = ['operator.pairing', 'operator.read', 'operator.write']
tokens = {'operator': {'token': ${JSON.stringify(afterToken)}, 'role': 'operator', 'scopes': scopes}}
c = sqlite3.connect(${JSON.stringify(databasePath)})
c.execute('BEGIN IMMEDIATE')
c.execute('DELETE FROM device_pairing_pending WHERE request_id = ?', (args[2],))
c.execute('UPDATE device_pairing_paired SET scopes_json = ?, approved_scopes_json = ?, tokens_json = ? WHERE device_id = ?', (json.dumps(scopes), json.dumps(scopes), json.dumps(tokens), identity['deviceId']))
c.execute("UPDATE device_auth_tokens SET token = ?, scopes_json = ?, updated_at_ms = 2 WHERE device_id = ? AND role = 'operator'", (${JSON.stringify(afterToken)}, json.dumps(scopes), identity['deviceId']))
c.commit()
print('{}')
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "must-not-reach-restored-clone",
        },
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        parseAutoPairApprovalReceipt(result.stdout),
        `${result.stdout}\n${result.stderr}`,
      ).toBe("approved-one");
      expect(fs.readFileSync(approveCallsFile, "utf-8")).toBe(`${requestId}\n`);
      for (const [file, content] of staleLegacyFiles) {
        expect(fs.readFileSync(file, "utf-8")).toBe(content);
      }
      const verify = spawnSync(
        "python3",
        [
          "-c",
          `import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print(json.dumps({
  'pending': c.execute('SELECT COUNT(*) FROM device_pairing_pending').fetchone()[0],
  'paired': c.execute('SELECT tokens_json FROM device_pairing_paired WHERE device_id = ?', (sys.argv[2],)).fetchone()[0],
  'auth': c.execute("SELECT token, scopes_json FROM device_auth_tokens WHERE device_id = ? AND role = 'operator'", (sys.argv[2],)).fetchone(),
  'unrelated': c.execute("SELECT token FROM device_auth_tokens WHERE device_id = ? AND role = 'operator'", (sys.argv[3],)).fetchone()[0],
}))`,
          databasePath,
          deviceId,
          unrelatedDeviceId,
        ],
        { encoding: "utf-8" },
      );
      expect(verify.status, verify.stderr).toBe(0);
      const observed = JSON.parse(verify.stdout);
      expect(observed.pending).toBe(0);
      expect(JSON.parse(observed.paired).operator).toEqual({
        token: afterToken,
        role: "operator",
        scopes: ["operator.pairing", "operator.read", "operator.write"],
      });
      expect(observed.auth[0]).toBe(afterToken);
      expect(JSON.parse(observed.auth[1])).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
      expect(observed.unrelated).toBe(unrelatedToken);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  pyIt25s("fails closed on an invalid canonical database instead of using legacy JSON", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(Buffer.from(policy as string).toString("base64"), {
      emitReceipt: true,
      localDeviceOnly: true,
    });
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-db-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "devices"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "identity"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "not a sqlite database");
      fs.writeFileSync(path.join(stateDir, "devices", "pending.json"), "{}");
      fs.writeFileSync(path.join(stateDir, "devices", "paired.json"), "{}");
      fs.writeFileSync(path.join(stateDir, "identity", "device.json"), "{}");
      const approveCallsFile = path.join(tmpDir, "approve-calls.log");
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(approveCallsFile)}, 'called');`,
        { mode: 0o755 },
      );
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(parseAutoPairApprovalReceipt(result.stdout)).toBe("list-pending-unsafe");
      expect(fs.existsSync(approveCallsFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  pyIt25s("rejects an unsupported canonical schema", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(Buffer.from(policy as string).toString("base64"), {
      emitReceipt: true,
      localDeviceOnly: true,
    });
    expectUnsafeCanonicalState(script, 14);
  });

  pyIt25s("does not create a missing shared-memory sidecar for a nonempty WAL", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(Buffer.from(policy as string).toString("base64"), {
      emitReceipt: true,
      localDeviceOnly: true,
    });
    expectUnsafeCanonicalState(script, 15, ["uncheckpointed canonical state"]);
  });

  pyIt25s("abandons legacy selection when the canonical database appears", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-db-race-")));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const databaseDir = path.join(stateDir, "state");
      const databasePath = path.join(databaseDir, "openclaw.sqlite");
      const approveCallsFile = path.join(tmpDir, "approve-calls.log");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      const request = {
        requestId: "legacy-raced-by-sqlite",
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.write"],
        isRepair: true,
      };
      const paired = {
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
            token: "legacy-token",
            role: "operator",
            scopes: ["operator.pairing"],
          },
        },
      };
      fs.writeFileSync(
        path.join(devicesDir, "pending.json"),
        JSON.stringify({ [request.requestId]: request }),
      );
      fs.writeFileSync(
        path.join(devicesDir, "paired.json"),
        JSON.stringify({ [deviceId]: paired }),
      );
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
          deviceId,
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
        }),
      );
      fs.writeFileSync(
        path.join(identityDir, "device-auth.json"),
        JSON.stringify({
          version: 1,
          deviceId,
          tokens: { operator: paired.tokens.operator },
        }),
      );
      const racingPolicy = `${policy}
import os as _race_os
_race_original_open = _race_os.open
_race_published = False
def _publish_sqlite_during_pending_open(path_value, flags, mode=0o777, *, dir_fd=None):
    global _race_published
    descriptor = _race_original_open(path_value, flags, mode, dir_fd=dir_fd)
    if not _race_published and dir_fd is not None and _race_os.fspath(path_value) == 'pending.json':
        _race_published = True
        _race_os.mkdir(${JSON.stringify(databaseDir)})
        database_fd = _race_original_open(
            ${JSON.stringify(databasePath)},
            _race_os.O_WRONLY | _race_os.O_CREAT | _race_os.O_EXCL,
            0o600,
        )
        _race_os.write(database_fd, b'canonical database publication in progress')
        _race_os.close(database_fd)
    return descriptor
_race_os.open = _publish_sqlite_during_pending_open
`;
      const script = buildAutoPairApprovalScript(
        Buffer.from(racingPolicy, "utf-8").toString("base64"),
        { emitReceipt: true, localDeviceOnly: true },
      );
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(approveCallsFile)}, 'called');`,
        { mode: 0o755 },
      );
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: "18789",
        },
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(parseAutoPairApprovalReceipt(result.stdout)).toBe("list-pending-unsafe");
      expect(fs.existsSync(databasePath)).toBe(true);
      expect(fs.existsSync(approveCallsFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
