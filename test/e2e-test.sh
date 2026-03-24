#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for NemoClaw + blueprint
# Runs inside the Docker sandbox

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() {
  echo -e "${RED}FAIL${NC}: $1"
  exit 1
}
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

# -------------------------------------------------------
info "1. Verify OpenClaw CLI is installed"
# -------------------------------------------------------
openclaw --version && pass "OpenClaw CLI installed" || fail "OpenClaw CLI not found"

# -------------------------------------------------------
info "2. Verify plugin can be installed"
# -------------------------------------------------------
openclaw plugins install /opt/nemoclaw 2>&1 && pass "Plugin installed" || {
  # If plugins install isn't available, verify the built artifacts exist
  if [ -f /opt/nemoclaw/dist/index.js ]; then
    pass "Plugin built successfully (dist/index.js exists)"
  else
    fail "Plugin build artifacts missing"
  fi
}

# -------------------------------------------------------
info "3. Verify blueprint YAML is valid"
# -------------------------------------------------------
python3 -c "
import yaml, sys
bp = yaml.safe_load(open('/opt/nemoclaw-blueprint/blueprint.yaml'))
assert bp['version'] == '0.1.0', f'Bad version: {bp[\"version\"]}'
profiles = bp['components']['inference']['profiles']
assert 'default' in profiles, 'Missing default profile'
assert 'vllm' in profiles, 'Missing vllm profile'
assert 'nim-local' in profiles, 'Missing nim-local profile'
print(f'Profiles: {list(profiles.keys())}')
" && pass "Blueprint YAML valid with all 3 profiles" || fail "Blueprint YAML invalid"

# -------------------------------------------------------
info "4. Verify blueprint runner plan command"
# -------------------------------------------------------
cd /opt/nemoclaw-blueprint
# Runner will fail at openshell prereq check (expected in test container)
# We just verify it gets past validation and profile resolution
NEMOCLAW_BLUEPRINT_PATH=/opt/nemoclaw-blueprint node --input-type=module -e "
  const { main } = await import('/opt/nemoclaw/dist/blueprint/runner.js');
  await main(['plan', '--profile', 'vllm', '--dry-run']).catch(() => {});
" 2>&1 | tee /tmp/plan-output.txt || true
grep -q "RUN_ID:" /tmp/plan-output.txt && pass "Blueprint plan generates run ID" || fail "No run ID in plan output"
grep -q "Validating blueprint" /tmp/plan-output.txt && pass "Blueprint runner validates before execution" || fail "No validation step"

# -------------------------------------------------------
info "5. Verify host OpenClaw detection (migration source)"
# -------------------------------------------------------
[ -f /sandbox/.openclaw/openclaw.json ] && pass "Host OpenClaw config detected" || fail "No host config"
[ -d /sandbox/.openclaw/workspace ] && pass "Host workspace directory exists" || fail "No workspace dir"
[ -d /sandbox/.openclaw/skills ] && pass "Host skills directory exists" || fail "No skills dir"
[ -d /sandbox/.openclaw/hooks ] && pass "Host hooks directory exists" || fail "No hooks dir"
[ -f /sandbox/.openclaw/hooks/demo-hook/HOOK.md ] && pass "Host hook fixture exists" || fail "No hook fixture"

# -------------------------------------------------------
info "6. Verify snapshot creation (migration pre-step)"
# -------------------------------------------------------
node --input-type=module -e "
  import fs from 'node:fs';
  import path from 'node:path';
  const { createSnapshot, listSnapshots } = await import('/opt/nemoclaw/dist/blueprint/snapshot.js');

  const snap = createSnapshot();
  if (!snap) throw new Error('Snapshot returned null');
  if (!fs.existsSync(snap)) throw new Error('Snapshot dir does not exist: ' + snap);
  const hookFile = path.join(snap, 'openclaw', 'hooks', 'demo-hook', 'HOOK.md');
  if (!fs.existsSync(hookFile)) throw new Error('Hook file missing from snapshot: ' + hookFile);

  const snaps = listSnapshots();
  if (snaps.length !== 1) throw new Error('Expected 1 snapshot, got ' + snaps.length);
  console.log('Snapshot created at: ' + snap);
  console.log('Files captured: ' + snaps[0].file_count);
" && pass "Migration snapshot created successfully" || fail "Snapshot creation failed"

# -------------------------------------------------------
info "7. Verify snapshot restore (eject path)"
# -------------------------------------------------------
node --input-type=module -e "
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  const { listSnapshots, rollbackFromSnapshot } = await import('/opt/nemoclaw/dist/blueprint/snapshot.js');

  const snaps = listSnapshots();
  const snapPath = snaps[0].path;

  // Simulate corruption: modify the host config
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const original = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  fs.writeFileSync(configPath, JSON.stringify({ corrupted: true }));

  // Rollback
  const success = rollbackFromSnapshot(snapPath);
  if (!success) throw new Error('Rollback returned false');

  // Verify restoration
  const restored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const version = (restored.meta || {}).lastTouchedVersion;
  if (version !== '2026.3.11') throw new Error('Restored config wrong: ' + JSON.stringify(restored));
  if ('corrupted' in restored) throw new Error('Config still corrupted after rollback');
  console.log('Restored config: ' + JSON.stringify(restored));
" && pass "Snapshot rollback restores original config" || fail "Rollback failed"

# -------------------------------------------------------
info "8. Verify migration inventory for external OpenClaw roots"
# -------------------------------------------------------
OPENCLAW_STATE_DIR=/sandbox/openclaw-state OPENCLAW_CONFIG_PATH=/sandbox/config/openclaw.json node --input-type=module <<'JS'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  cleanupSnapshotBundle,
  createArchiveFromDirectory,
  createSnapshotBundle,
  detectHostOpenClaw,
} from "/opt/nemoclaw/dist/commands/migration-state.js";

const logger = {
  info() {},
  warn() {},
  error(message) {
    throw new Error(String(message));
  },
  debug() {},
};

const state = detectHostOpenClaw(process.env);
if (!state.exists) {
  throw new Error("detectHostOpenClaw did not find the overridden install");
}
if (state.stateDir !== "/sandbox/openclaw-state") {
  throw new Error(`Unexpected state dir: ${state.stateDir}`);
}
if (state.configPath !== "/sandbox/config/openclaw.json") {
  throw new Error(`Unexpected config path: ${state.configPath}`);
}
if (state.externalRoots.length < 3) {
  throw new Error(`Expected at least 3 external roots, got ${state.externalRoots.length}`);
}

const bundle = createSnapshotBundle(state, logger, { persist: false });
if (!bundle) {
  throw new Error("createSnapshotBundle returned null");
}

try {
  const workspaceRoot = bundle.manifest.externalRoots.find((root) => root.kind === "workspace");
  if (!workspaceRoot) {
    throw new Error("Missing workspace root in manifest");
  }
  const snapshotLink = path.join(
    bundle.snapshotDir,
    workspaceRoot.snapshotRelativePath,
    "shared-link.md",
  );
  if (!fs.lstatSync(snapshotLink).isSymbolicLink()) {
    throw new Error(`Snapshot did not preserve symlink: ${snapshotLink}`);
  }

  const sandboxConfig = JSON.parse(
    fs.readFileSync(path.join(bundle.preparedStateDir, "openclaw.json"), "utf-8"),
  );
  if (sandboxConfig.agents.defaults.workspace !== workspaceRoot.sandboxPath) {
    throw new Error(
      `Sandbox config was not rewritten for default workspace: ${sandboxConfig.agents.defaults.workspace}`,
    );
  }
  if (sandboxConfig.agents.list[0].agentDir !== "/sandbox/.nemoclaw/migration/agent-dirs/agent-dirs-main-agent-dir") {
    throw new Error(`Sandbox config did not rewrite agentDir: ${sandboxConfig.agents.list[0].agentDir}`);
  }

  const archivePath = path.join(bundle.archivesDir, "workspace.tar");
  await createArchiveFromDirectory(path.join(bundle.snapshotDir, workspaceRoot.snapshotRelativePath), archivePath);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-archive-"));
  execFileSync("tar", ["-xf", archivePath, "-C", extractDir]);
  const extractedLink = path.join(extractDir, "shared-link.md");
  if (!fs.lstatSync(extractedLink).isSymbolicLink()) {
    throw new Error(`Tar archive did not preserve symlink: ${extractedLink}`);
  }

  const fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-userprofile-"));
  fs.mkdirSync(path.join(fallbackHome, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(fallbackHome, ".openclaw", "openclaw.json"), "{}");
  const fallbackState = detectHostOpenClaw({
    HOME: "",
    USERPROFILE: fallbackHome,
  });
  if (!fallbackState.exists || fallbackState.stateDir !== path.join(fallbackHome, ".openclaw")) {
    throw new Error("USERPROFILE fallback did not resolve the host OpenClaw state");
  }
} finally {
  cleanupSnapshotBundle(bundle);
}
JS
pass "Migration inventory handles overrides, external roots, and symlink-safe archives"

# -------------------------------------------------------
info "9. Verify plugin TypeScript compilation"
# -------------------------------------------------------
[ -f /opt/nemoclaw/dist/index.js ] && pass "index.js compiled" || fail "index.js missing"
[ -f /opt/nemoclaw/dist/commands/slash.js ] && pass "slash.js compiled" || fail "slash.js missing"
[ -f /opt/nemoclaw/dist/commands/migration-state.js ] && pass "migration-state.js compiled" || fail "migration-state.js missing"
[ -f /opt/nemoclaw/dist/blueprint/state.js ] && pass "state.js compiled" || fail "state.js missing"

# -------------------------------------------------------
info "10. Verify NemoClaw state management"
# -------------------------------------------------------
node --input-type=module -e "
import { strict as assert } from 'node:assert';
const { loadState, saveState, clearState } = await import('/opt/nemoclaw/dist/blueprint/state.js');

// Initial state should be empty
let state = loadState();
assert.equal(state.lastAction, null, 'Initial state should be null');

// Save and reload
saveState({ ...state, lastAction: 'migrate', lastRunId: 'test-123', sandboxName: 'openclaw' });
state = loadState();
assert.equal(state.lastAction, 'migrate', 'Should be migrate');
assert.equal(state.lastRunId, 'test-123', 'Should be test-123');
assert.notEqual(state.updatedAt, null, 'Should have timestamp');

// Clear
clearState();
state = loadState();
assert.equal(state.lastAction, null, 'Should be cleared');

console.log('State management: create, save, load, clear all working');
" && pass "NemoClaw state management works" || fail "State management broken"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ALL E2E TESTS PASSED${NC}"
echo -e "${GREEN}========================================${NC}"
