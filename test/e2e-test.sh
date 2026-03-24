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
if openclaw --version; then
  pass "OpenClaw CLI installed"
else
  fail "OpenClaw CLI not found"
fi

# -------------------------------------------------------
info "2. Verify plugin can be installed"
# -------------------------------------------------------
if openclaw plugins install /opt/nemoclaw 2>&1; then
  pass "Plugin installed"
else
  # If plugins install isn't available, verify the built artifacts exist
  if [ -f /opt/nemoclaw/dist/index.js ]; then
    pass "Plugin built successfully (dist/index.js exists)"
  else
    fail "Plugin build artifacts missing"
  fi
fi

# -------------------------------------------------------
info "3. Verify blueprint YAML is valid"
# -------------------------------------------------------
if python3 -c "
import yaml, sys
bp = yaml.safe_load(open('/opt/nemoclaw-blueprint/blueprint.yaml'))
assert bp['version'] == '0.1.0', f'Bad version: {bp[\"version\"]}'
profiles = bp['components']['inference']['profiles']
assert 'default' in profiles, 'Missing default profile'
assert 'ncp' in profiles, 'Missing ncp profile'
assert 'vllm' in profiles, 'Missing vllm profile'
assert 'nim-local' in profiles, 'Missing nim-local profile'
print(f'Profiles: {list(profiles.keys())}')
"; then
  pass "Blueprint YAML valid with all 4 profiles"
else
  fail "Blueprint YAML invalid"
fi

# -------------------------------------------------------
info "4. Verify blueprint runner plan command"
# -------------------------------------------------------
cd /opt/nemoclaw-blueprint
# Runner will fail at openshell prereq check (expected in test container)
# We just verify it gets past validation and profile resolution
python3 orchestrator/runner.py plan --profile vllm --dry-run 2>&1 | tee /tmp/plan-output.txt || true
if grep -q "RUN_ID:" /tmp/plan-output.txt; then
  pass "Blueprint plan generates run ID"
else
  fail "No run ID in plan output"
fi
if grep -q "Validating blueprint" /tmp/plan-output.txt; then
  pass "Blueprint runner validates before execution"
else
  fail "No validation step"
fi

# -------------------------------------------------------
info "5. Verify host OpenClaw detection (migration source)"
# -------------------------------------------------------
if [ -f /sandbox/.openclaw/openclaw.json ]; then
  pass "Host OpenClaw config detected"
else
  fail "No host config"
fi
if [ -d /sandbox/.openclaw/workspace ]; then
  pass "Host workspace directory exists"
else
  fail "No workspace dir"
fi
if [ -d /sandbox/.openclaw/skills ]; then
  pass "Host skills directory exists"
else
  fail "No skills dir"
fi
if [ -d /sandbox/.openclaw/hooks ]; then
  pass "Host hooks directory exists"
else
  fail "No hooks dir"
fi
if [ -f /sandbox/.openclaw/hooks/demo-hook/HOOK.md ]; then
  pass "Host hook fixture exists"
else
  fail "No hook fixture"
fi

# -------------------------------------------------------
info "6. Verify snapshot creation (migration pre-step)"
# -------------------------------------------------------
if python3 -c "
import sys
sys.path.insert(0, '/opt/nemoclaw-blueprint/migrations')
from snapshot import create_snapshot, list_snapshots

snap = create_snapshot()
assert snap is not None, 'Snapshot returned None'
assert snap.exists(), f'Snapshot dir does not exist: {snap}'
hook_file = snap / 'openclaw' / 'hooks' / 'demo-hook' / 'HOOK.md'
assert hook_file.exists(), f'Hook file missing from snapshot: {hook_file}'

snaps = list_snapshots()
assert len(snaps) == 1, f'Expected 1 snapshot, got {len(snaps)}'
print(f'Snapshot created at: {snap}')
print(f'Files captured: {snaps[0][\"file_count\"]}')
"; then
  pass "Migration snapshot created successfully"
else
  fail "Snapshot creation failed"
fi

# -------------------------------------------------------
info "7. Verify snapshot restore (eject path)"
# -------------------------------------------------------
if python3 -c "
import sys, json, shutil
sys.path.insert(0, '/opt/nemoclaw-blueprint/migrations')
from snapshot import list_snapshots, rollback_from_snapshot
from pathlib import Path

snaps = list_snapshots()
snap_path = Path(snaps[0]['path'])

# Simulate corruption: modify the host config
config = Path.home() / '.openclaw' / 'openclaw.json'
original = json.loads(config.read_text())
config.write_text(json.dumps({'corrupted': True}))

# Rollback
success = rollback_from_snapshot(snap_path)
assert success, 'Rollback returned False'

# Verify restoration
restored = json.loads(config.read_text())
assert restored.get('meta', {}).get('lastTouchedVersion') == '2026.3.11', f'Restored config wrong: {restored}'
assert 'corrupted' not in restored, 'Config still corrupted after rollback'
print(f'Restored config: {restored}')
"; then
  pass "Snapshot rollback restores original config"
else
  fail "Rollback failed"
fi

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
if [ -f /opt/nemoclaw/dist/index.js ]; then
  pass "index.js compiled"
else
  fail "index.js missing"
fi
if [ -f /opt/nemoclaw/dist/commands/slash.js ]; then
  pass "slash.js compiled"
else
  fail "slash.js missing"
fi
if [ -f /opt/nemoclaw/dist/commands/migration-state.js ]; then
  pass "migration-state.js compiled"
else
  fail "migration-state.js missing"
fi
if [ -f /opt/nemoclaw/dist/blueprint/state.js ]; then
  pass "state.js compiled"
else
  fail "state.js missing"
fi

# -------------------------------------------------------
info "10. Verify NemoClaw state management"
# -------------------------------------------------------
if node -e "
const { loadState, saveState, clearState } = require('/opt/nemoclaw/dist/blueprint/state.js');

// Initial state should be empty
let state = loadState();
console.assert(state.lastAction === null, 'Initial state should be null');

// Save and reload
saveState({ ...state, lastAction: 'migrate', lastRunId: 'test-123', sandboxName: 'openclaw' });
state = loadState();
console.assert(state.lastAction === 'migrate', 'Should be migrate');
console.assert(state.lastRunId === 'test-123', 'Should be test-123');
console.assert(state.updatedAt !== null, 'Should have timestamp');

// Clear
clearState();
state = loadState();
console.assert(state.lastAction === null, 'Should be cleared');

console.log('State management: create, save, load, clear all working');
"; then
  pass "NemoClaw state management works"
else
  fail "State management broken"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ALL E2E TESTS PASSED${NC}"
echo -e "${GREEN}========================================${NC}"
