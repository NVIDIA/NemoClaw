// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runOpenclaw } from "./auto-pair-settlement-fixture";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);
const APPROVAL_POLICY_DIR = path.join(import.meta.dirname, "..", "../../..", "scripts", "lib");
const PUBLIC_KEY = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
const DEVICE_ID = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
const IDENTITY = {
  deviceId: DEVICE_ID,
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
};
const REQUEST = {
  requestId: "request-1",
  deviceId: DEVICE_ID,
  publicKey: PUBLIC_KEY,
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.pairing"],
  ts: 100,
};

function startScriptHeredoc(src: string, marker: string): string {
  const match = src.match(new RegExp(`<<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n${marker}`));
  expect(match).not.toBeNull();
  return match![1];
}

function autoPairPythonScript(src: string, tmpDir: string): string {
  const statusPath = path.join(tmpDir, "auto-pair-status.json");
  const policyPath = path.join(tmpDir, "openclaw_device_approval_policy.py");
  const pairingStatePath = path.join(tmpDir, "openclaw_pairing_state.py");
  fs.writeFileSync(statusPath, "", { mode: 0o600 });
  fs.copyFileSync(path.join(APPROVAL_POLICY_DIR, "openclaw_device_approval_policy.py"), policyPath);
  fs.copyFileSync(path.join(APPROVAL_POLICY_DIR, "openclaw_pairing_state.py"), pairingStatePath);
  fs.chmodSync(policyPath, 0o444);
  fs.chmodSync(pairingStatePath, 0o444);
  return startScriptHeredoc(src, "PYAUTOPAIR")
    .replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(policyPath)}`,
    )
    .replace(
      "STATUS_PATH = '/tmp/nemoclaw-auto-pair-status.json'",
      `STATUS_PATH = ${JSON.stringify(statusPath)}`,
    )
    .replaceAll("time.time()", "_nemoclaw_test_time()")
    .replaceAll("time.sleep(", "_nemoclaw_test_sleep(")
    .replace(
      "import time",
      `import time
_nemoclaw_test_clock = [time.time()]
_nemoclaw_test_time = lambda: _nemoclaw_test_clock[0]
def _nemoclaw_test_sleep(seconds): _nemoclaw_test_clock.__setitem__(0, _nemoclaw_test_clock[0] + min(max(float(seconds), 0), 0.25))
`,
    );
}

function createCanonicalSqlitePairingState(stateDir: string): string {
  const database = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const setup = spawnSync(
    "python3",
    [
      "-c",
      `
import json
import os
import sqlite3
import sys

database, identity_json, request_json = sys.argv[1:]
identity = json.loads(identity_json)
request = json.loads(request_json)
os.umask(0o007)
connection = sqlite3.connect(database)
connection.execute('PRAGMA journal_mode = WAL')
connection.execute('PRAGMA wal_autocheckpoint = 0')
connection.executescript('''
CREATE TABLE device_identities (
  identity_key TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE device_pairing_pending (
  request_id TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  display_name TEXT,
  platform TEXT,
  device_family TEXT,
  client_id TEXT,
  client_mode TEXT,
  browser_origin TEXT,
  role TEXT,
  roles_json TEXT,
  scopes_json TEXT,
  remote_ip TEXT,
  silent INTEGER,
  is_repair INTEGER,
  ts INTEGER NOT NULL,
  refreshed_at_ms INTEGER
) STRICT;
CREATE TABLE device_pairing_paired (
  device_id TEXT NOT NULL PRIMARY KEY,
  public_key TEXT NOT NULL,
  display_name TEXT,
  operator_label TEXT,
  platform TEXT,
  device_family TEXT,
  client_id TEXT,
  client_mode TEXT,
  browser_origin TEXT,
  role TEXT,
  roles_json TEXT,
  scopes_json TEXT,
  approved_scopes_json TEXT,
  remote_ip TEXT,
  tokens_json TEXT,
  approved_via TEXT,
  node_surface_json TEXT,
  pending_node_surface_json TEXT,
  created_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  last_seen_reason TEXT
) STRICT;
CREATE TABLE device_auth_tokens (
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, role)
) STRICT;
PRAGMA user_version = 15;
''')
connection.execute(
    '''INSERT INTO device_identities
       (identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms)
       VALUES ('primary', ?, ?, ?, 1, 1)''',
    (identity['deviceId'], identity['publicKeyPem'], identity.get('privateKeyPem', 'private')),
)
connection.execute(
    '''INSERT INTO device_pairing_pending
       (request_id, device_id, public_key, client_id, client_mode, role,
        roles_json, scopes_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
    (
        request['requestId'], request['deviceId'], request['publicKey'], request.get('clientId'),
        request.get('clientMode'), request.get('role'), json.dumps(request.get('roles')),
        json.dumps(request.get('scopes')), request.get('ts', 1),
    ),
)
connection.execute(
    '''INSERT INTO device_auth_tokens
       (device_id, role, token, scopes_json, updated_at_ms)
       VALUES (?, 'operator', 'gateway-secret-token', '["operator.pairing"]', 1)''',
    (request['deviceId'],),
)
connection.commit()
os._exit(0)
`,
      database,
      JSON.stringify(IDENTITY),
      JSON.stringify(REQUEST),
    ],
    { encoding: "utf-8" },
  );
  expect(setup.status, setup.stderr).toBe(0);
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
  return database;
}

function writeFakeOpenclaw(fakeOpenclaw: string, approveLog: string): void {
  fs.writeFileSync(
    fakeOpenclaw,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approveLog)}
  exit 0
fi
exit 2
`,
    { mode: 0o755 },
  );
}

async function expectUnsafeCanonicalState(
  src: string,
  version: number,
  expectedReason: string,
  walContents: readonly string[] = [],
): Promise<void> {
  const tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-reject-")),
  );
  const fakeOpenclaw = path.join(tmpDir, "openclaw");
  const stateDir = path.join(tmpDir, "state");
  const approveLog = path.join(tmpDir, "approve-called");
  const database = createCanonicalSqlitePairingState(stateDir);
  const updateVersion = spawnSync(
    "python3",
    [
      "-c",
      "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute(f'PRAGMA user_version = {sys.argv[2]}'); c.commit(); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()",
      database,
      String(version),
    ],
    { encoding: "utf-8" },
  );
  expect(updateVersion.status, updateVersion.stderr).toBe(0);
  fs.rmSync(`${database}-wal`, { force: true });
  fs.rmSync(`${database}-shm`, { force: true });
  expect([...fs.readFileSync(database).subarray(18, 20)]).toEqual([2, 2]);
  expect(fs.existsSync(`${database}-wal`)).toBe(false);
  expect(fs.existsSync(`${database}-shm`)).toBe(false);
  for (const contents of walContents) {
    fs.writeFileSync(`${database}-wal`, contents);
    fs.chmodSync(`${database}-wal`, 0o660);
  }
  writeFakeOpenclaw(fakeOpenclaw, approveLog);

  try {
    const run = await runOpenclaw("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENCLAW_BIN: fakeOpenclaw,
        OPENCLAW_STATE_DIR: stateDir,
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
      },
      timeout: 30_000,
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "[auto-pair] stage=validation rejected request=request-1 reason=not-allowlisted",
    );
    expect(run.stdout).toContain(expectedReason);
    expect(fs.existsSync(approveLog)).toBe(false);
    expect(fs.existsSync(`${database}-shm`)).toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("nemoclaw-start canonical SQLite auto-pair bootstrap", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("approves a gated initial CLI request from shared canonical SQLite state", async () => {
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-sqlite-")),
    );
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const identityDir = path.join(stateDir, "identity");
    const devicesDir = path.join(stateDir, "devices");
    const approveLog = path.join(tmpDir, "approve-called");
    const database = createCanonicalSqlitePairingState(stateDir);
    const databaseBefore = fs.readFileSync(database);
    const walProof = spawnSync(
      "python3",
      [
        "-c",
        "import sqlite3,sys; client=sys.argv[1]; assert sqlite3.connect(f'file:{client}?immutable=1', uri=True).execute(\"SELECT COUNT(*) FROM sqlite_master WHERE name='device_identities'\").fetchone()[0] == 0; assert sqlite3.connect(f'file:{client}?mode=ro', uri=True).execute('SELECT COUNT(*) FROM device_identities').fetchone()[0] == 1; assert sqlite3.connect(f'file:{client}?mode=ro', uri=True).execute('SELECT COUNT(*) FROM device_pairing_pending').fetchone()[0] == 1",
        database,
      ],
      { encoding: "utf-8" },
    );
    expect(walProof.status, walProof.stderr).toBe(0);

    // Conflicting legacy files prove that an existing canonical database is
    // authoritative and the watcher does not mix the two storage layouts.
    fs.mkdirSync(identityDir, { recursive: true });
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(identityDir, "device.json"),
      JSON.stringify({ ...IDENTITY, deviceId: "stale-legacy-device" }),
    );
    fs.writeFileSync(
      path.join(devicesDir, "pending.json"),
      JSON.stringify({ "request-1": { ...REQUEST, clientId: "browser" } }),
    );
    writeFakeOpenclaw(fakeOpenclaw, approveLog);

    try {
      const run = await runOpenclaw("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] stage=validation accepted request=request-1 reason=allowlisted-initial-cli",
      );
      expect(run.stdout).toContain("[auto-pair] approved initial CLI pairing request=request-1");
      expect(fs.existsSync(approveLog)).toBe(true);
      expect(fs.readFileSync(database)).toEqual(databaseBefore);
      expect(fs.existsSync(`${database}-journal`)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("fails closed instead of following a linked canonical SQLite database", async () => {
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-sqlite-reject-")),
    );
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const identityDir = path.join(stateDir, "identity");
    const devicesDir = path.join(stateDir, "devices");
    const approveLog = path.join(tmpDir, "approve-called");
    const database = createCanonicalSqlitePairingState(stateDir);
    const linkedDatabase = path.join(tmpDir, "linked-openclaw.sqlite");
    fs.renameSync(database, linkedDatabase);
    fs.symlinkSync(linkedDatabase, database);
    const databaseBefore = fs.readFileSync(linkedDatabase);

    // These valid legacy files must not rescue a canonical path that fails the
    // no-symlink invariant.
    fs.mkdirSync(identityDir, { recursive: true });
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(path.join(identityDir, "device.json"), JSON.stringify(IDENTITY));
    fs.writeFileSync(
      path.join(devicesDir, "pending.json"),
      JSON.stringify({ "request-1": REQUEST }),
    );
    writeFakeOpenclaw(fakeOpenclaw, approveLog);

    try {
      const run = await runOpenclaw("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] stage=validation rejected request=request-1 reason=not-allowlisted",
      );
      expect(run.stdout).not.toContain("approved initial CLI pairing");
      expect(fs.existsSync(approveLog)).toBe(false);
      expect(fs.readFileSync(linkedDatabase)).toEqual(databaseBefore);
      expect(fs.existsSync(`${database}-journal`)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("rejects an unsupported canonical schema", async () => {
    await expectUnsafeCanonicalState(src, 14, "unsupported canonical device state schema");
  }, 40_000);

  it("does not create a missing shared-memory sidecar for a nonempty WAL", async () => {
    await expectUnsafeCanonicalState(
      src,
      15,
      "canonical pairing-state WAL is missing its shared-memory sidecar",
      ["uncheckpointed canonical state"],
    );
  }, 40_000);
});
