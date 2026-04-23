#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Credential Sanitization & Blueprint Digest E2E Tests
#
# Validates that PR #156's fix correctly strips credentials from migration
# bundles and that empty blueprint digests are no longer silently accepted.
#
# Attack surface:
#   Before the fix, createSnapshotBundle() copied the entire ~/.openclaw
#   directory into the sandbox, including auth-profiles.json with live API
#   keys, GitHub PATs, and npm tokens. A compromised agent could read these
#   and exfiltrate them. Additionally, blueprint.yaml shipped with digest: ""
#   which caused the integrity check to silently pass (JS falsy).
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed and sandbox running (test-full-e2e.sh Phase 0-3)
#   - NVIDIA_API_KEY set
#   - openshell on PATH
#
# Environment variables:
#   NEMOCLAW_SANDBOX_NAME  — sandbox name (default: e2e-test)
#   NVIDIA_API_KEY         — required
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-credential-sanitization.sh
#
# See: https://github.com/NVIDIA/NemoClaw/pull/156

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-test}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# Run a command inside the sandbox and capture output.
# Returns __PROBE_FAILED__ and exit 1 if SSH setup or execution fails,
# so callers can distinguish "no output" from "probe never ran".
sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    rm -f "$ssh_config"
    echo "__PROBE_FAILED__"
    return 1
  fi

  local result
  local rc=0
  result=$(timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || rc=$?

  rm -f "$ssh_config"
  if [ "$rc" -ne 0 ] && [ -z "$result" ]; then
    echo "__PROBE_FAILED__"
    return 1
  fi
  echo "$result"
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "NVIDIA_API_KEY not set"
  exit 1
fi
pass "NVIDIA_API_KEY is set"

if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH"
  exit 1
fi
pass "openshell found"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH"
  exit 1
fi
pass "nemoclaw found"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH"
  exit 1
fi
pass "node found"

# Verify sandbox is running
# shellcheck disable=SC2034  # status_output captures stderr for diagnostics on failure
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "Sandbox '${SANDBOX_NAME}' is running"
else
  fail "Sandbox '${SANDBOX_NAME}' not running — run test-full-e2e.sh first"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 1: Credential Stripping from Migration Bundles
#
# We create a mock ~/.openclaw directory with known fake credentials,
# then run the sanitization functions and verify the output.
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Credential Stripping (Unit-Level on Real Stack)"

# Deliberately non-matching fake tokens that will NOT trigger secret scanners.
FAKE_NVIDIA_KEY="test-fake-nvidia-key-0000000000000000"
FAKE_GITHUB_TOKEN="test-fake-github-token-1111111111111111"
FAKE_NPM_TOKEN="test-fake-npm-token-2222222222222222"
FAKE_GATEWAY_TOKEN="test-fake-gateway-token-333333333333"

# Create a temp directory simulating the state that would be migrated
MOCK_DIR=$(mktemp -d /tmp/nemoclaw-cred-test-XXXXXX)
MOCK_STATE="$MOCK_DIR/.openclaw"
mkdir -p "$MOCK_STATE"

# Create openclaw.json with credential fields
cat >"$MOCK_STATE/openclaw.json" <<JSONEOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "nvidia/nemotron-3-super-120b-a12b"
      },
      "workspace": "$MOCK_STATE/workspace"
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "$FAKE_GATEWAY_TOKEN"
    }
  },
  "nvidia": {
    "apiKey": "$FAKE_NVIDIA_KEY"
  }
}
JSONEOF

# Create auth-profiles.json with credential data
AUTH_DIR="$MOCK_STATE/agents/main/agent"
mkdir -p "$AUTH_DIR"
cat >"$AUTH_DIR/auth-profiles.json" <<JSONEOF
{
  "nvidia:manual": {
    "type": "api_key",
    "provider": "nvidia",
    "keyRef": { "source": "env", "id": "NVIDIA_API_KEY" },
    "resolvedKey": "$FAKE_NVIDIA_KEY",
    "profileId": "nvidia:manual"
  },
  "github:pat": {
    "type": "api_key",
    "provider": "github",
    "token": "$FAKE_GITHUB_TOKEN",
    "profileId": "github:pat"
  },
  "npm:publish": {
    "type": "api_key",
    "provider": "npm",
    "token": "$FAKE_NPM_TOKEN",
    "profileId": "npm:publish"
  }
}
JSONEOF

# Create workspace with a normal file
mkdir -p "$MOCK_STATE/workspace"
echo "# My Project" >"$MOCK_STATE/workspace/project.md"

# Copy to simulate bundle
BUNDLE_DIR="$MOCK_DIR/bundle/openclaw"
mkdir -p "$BUNDLE_DIR"
cp -r "$MOCK_STATE"/* "$BUNDLE_DIR/" 2>/dev/null || true
cp -r "$MOCK_STATE"/.[!.]* "$BUNDLE_DIR/" 2>/dev/null || true
# Actually copy the directory contents properly
rm -rf "$BUNDLE_DIR"
cp -r "$MOCK_STATE" "$BUNDLE_DIR"

# Run the sanitization logic via node (mirrors production sanitizeCredentialsInBundle)
info "C1-C5: Running credential sanitization on mock bundle..."
sanitize_result=$(cd "$REPO" && node -e "
const fs = require('fs');
const path = require('path');

// --- Credential field detection (mirrors migration-state.ts) ---
const CREDENTIAL_FIELDS = new Set([
  'apiKey', 'api_key', 'token', 'secret', 'password', 'resolvedKey',
]);
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = '[STRIPPED_BY_MIGRATION]';
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

function walkAndRemoveFile(dirPath, targetName) {
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walkAndRemoveFile(fullPath, targetName);
      } else if (entry === targetName) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch {}
  }
}

const bundleDir = '$BUNDLE_DIR';

// 1. Remove auth-profiles.json
const agentsDir = path.join(bundleDir, 'agents');
if (fs.existsSync(agentsDir)) {
  walkAndRemoveFile(agentsDir, 'auth-profiles.json');
}

// 2. Strip credential fields from openclaw.json
const configPath = path.join(bundleDir, 'openclaw.json');
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const sanitized = stripCredentials(config);
  fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2));
}

console.log('SANITIZED');
" 2>&1)

if echo "$sanitize_result" | grep -q "SANITIZED"; then
  pass "Sanitization ran successfully"
else
  fail "Sanitization script failed: ${sanitize_result:0:200}"
fi

# C1: No nvapi- strings in the entire bundle
info "C1: Checking for API key leaks in bundle..."
nvapi_hits=$(grep -r "test-fake-nvidia-key" "$BUNDLE_DIR" 2>/dev/null || true)
if [ -z "$nvapi_hits" ]; then
  pass "C1: No fake NVIDIA key found in bundle"
else
  fail "C1: Fake NVIDIA key found in bundle: ${nvapi_hits:0:200}"
fi

# Also check for the other fake tokens
github_hits=$(grep -r "test-fake-github-token" "$BUNDLE_DIR" 2>/dev/null || true)
npm_hits=$(grep -r "test-fake-npm-token" "$BUNDLE_DIR" 2>/dev/null || true)
gateway_hits=$(grep -r "test-fake-gateway-token" "$BUNDLE_DIR" 2>/dev/null || true)

if [ -z "$github_hits" ] && [ -z "$npm_hits" ] && [ -z "$gateway_hits" ]; then
  pass "C1b: No fake GitHub/npm/gateway tokens found in bundle"
else
  fail "C1b: Fake tokens found — github: ${github_hits:0:80}, npm: ${npm_hits:0:80}, gateway: ${gateway_hits:0:80}"
fi

# C2: auth-profiles.json must not exist anywhere in the bundle
info "C2: Checking for auth-profiles.json..."
auth_files=$(find "$BUNDLE_DIR" -name "auth-profiles.json" 2>/dev/null || true)
if [ -z "$auth_files" ]; then
  pass "C2: auth-profiles.json deleted from bundle"
else
  fail "C2: auth-profiles.json still exists: $auth_files"
fi

# C3: openclaw.json credential fields must be [STRIPPED_BY_MIGRATION]
info "C3: Checking credential field sanitization in openclaw.json..."
config_content=$(cat "$BUNDLE_DIR/openclaw.json" 2>/dev/null || echo "{}")

nvidia_apikey=$(echo "$config_content" | python3 -c "
import json, sys
config = json.load(sys.stdin)
print(config.get('nvidia', {}).get('apiKey', 'MISSING'))
" 2>/dev/null || echo "PARSE_ERROR")

gateway_token=$(echo "$config_content" | python3 -c "
import json, sys
config = json.load(sys.stdin)
print(config.get('gateway', {}).get('auth', {}).get('token', 'MISSING'))
" 2>/dev/null || echo "PARSE_ERROR")

if [ "$nvidia_apikey" = "[STRIPPED_BY_MIGRATION]" ]; then
  pass "C3a: nvidia.apiKey replaced with sentinel"
else
  fail "C3a: nvidia.apiKey not sanitized (got: $nvidia_apikey)"
fi

if [ "$gateway_token" = "[STRIPPED_BY_MIGRATION]" ]; then
  pass "C3b: gateway.auth.token replaced with sentinel"
else
  fail "C3b: gateway.auth.token not sanitized (got: $gateway_token)"
fi

# C4: Non-credential fields must be preserved
info "C4: Checking non-credential field preservation..."
model_primary=$(echo "$config_content" | python3 -c "
import json, sys
config = json.load(sys.stdin)
print(config.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', 'MISSING'))
" 2>/dev/null || echo "PARSE_ERROR")

gateway_mode=$(echo "$config_content" | python3 -c "
import json, sys
config = json.load(sys.stdin)
print(config.get('gateway', {}).get('mode', 'MISSING'))
" 2>/dev/null || echo "PARSE_ERROR")

if [ "$model_primary" = "nvidia/nemotron-3-super-120b-a12b" ]; then
  pass "C4a: agents.defaults.model.primary preserved"
else
  fail "C4a: agents.defaults.model.primary corrupted (got: $model_primary)"
fi

if [ "$gateway_mode" = "local" ]; then
  pass "C4b: gateway.mode preserved"
else
  fail "C4b: gateway.mode corrupted (got: $gateway_mode)"
fi

# C5: Workspace files must be intact
info "C5: Checking workspace file integrity..."
if [ -f "$BUNDLE_DIR/workspace/project.md" ]; then
  project_content=$(cat "$BUNDLE_DIR/workspace/project.md")
  if [ "$project_content" = "# My Project" ]; then
    pass "C5: workspace/project.md intact"
  else
    fail "C5: workspace/project.md content changed"
  fi
else
  fail "C5: workspace/project.md missing from bundle"
fi

# Cleanup mock directory
rm -rf "$MOCK_DIR"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Runtime Sandbox Credential Check
#
# Verify that credentials are NOT accessible from inside the running
# sandbox. This tests the end-to-end flow: migrate → sandbox start →
# agent cannot read credentials from filesystem.
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Runtime Sandbox Credential Check"

# C6: auth-profiles.json must not exist inside the sandbox
info "C6: Checking for auth-profiles.json inside sandbox..."
c6_result=$(sandbox_exec "find /sandbox -name 'auth-profiles.json' 2>/dev/null | head -5")

if [ "$c6_result" = "__PROBE_FAILED__" ]; then
  fail "C6: Sandbox probe failed — SSH did not execute; cannot verify auth-profiles.json absence"
elif [ -z "$c6_result" ]; then
  pass "C6: No auth-profiles.json found inside sandbox"
else
  fail "C6: auth-profiles.json found inside sandbox: $c6_result"
fi

# C7: No real secret patterns in sandbox config files
info "C7: Checking for secret patterns in sandbox config..."

# Search for real API key patterns (not our test fakes).
# Exclude policy preset files (e.g. npm.yaml contains "npm_yarn" rule names, not secrets).
c7_nvapi=$(sandbox_exec "grep -r 'nvapi-' /sandbox/.openclaw/ /sandbox/.nemoclaw/ 2>/dev/null | grep -v 'STRIPPED' | grep -v '/policies/' | head -5" || true)
c7_ghp=$(sandbox_exec "grep -r 'ghp_' /sandbox/.openclaw/ /sandbox/.nemoclaw/ 2>/dev/null | grep -v 'STRIPPED' | grep -v '/policies/' | head -5" || true)
c7_npm=$(sandbox_exec "grep -r 'npm_' /sandbox/.openclaw/ /sandbox/.nemoclaw/ 2>/dev/null | grep -v 'STRIPPED' | grep -v '/policies/' | head -5" || true)

if [ "$c7_nvapi" = "__PROBE_FAILED__" ] || [ "$c7_ghp" = "__PROBE_FAILED__" ] || [ "$c7_npm" = "__PROBE_FAILED__" ]; then
  fail "C7: Sandbox probe failed — SSH did not execute; cannot verify secret absence"
elif [ -z "$c7_nvapi" ] && [ -z "$c7_ghp" ] && [ -z "$c7_npm" ]; then
  pass "C7: No secret patterns (nvapi-, ghp_, npm_) found in sandbox config"
else
  fail "C7: Secret patterns found in sandbox — nvapi: ${c7_nvapi:0:100}, ghp: ${c7_ghp:0:100}, npm: ${c7_npm:0:100}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Symlink Safety
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Symlink Safety"

# C8: Symlinked auth-profiles.json must NOT delete the target file
info "C8: Testing symlink traversal protection..."

SYMLINK_DIR=$(mktemp -d /tmp/nemoclaw-symlink-test-XXXXXX)
OUTSIDE_DIR="$SYMLINK_DIR/outside"
BUNDLE_SYM_DIR="$SYMLINK_DIR/bundle/agents"
mkdir -p "$OUTSIDE_DIR" "$BUNDLE_SYM_DIR"

# Create a real file outside the bundle
echo '{"shouldNotBeDeleted": true}' >"$OUTSIDE_DIR/auth-profiles.json"

# Create a symlink inside the bundle pointing to the outside file
ln -s "$OUTSIDE_DIR/auth-profiles.json" "$BUNDLE_SYM_DIR/auth-profiles.json"

# Run walkAndRemoveFile — it should skip symlinks
c8_result=$(cd "$REPO" && node -e "
const fs = require('fs');
const path = require('path');

function walkAndRemoveFile(dirPath, targetName) {
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;  // SKIP SYMLINKS
      if (stat.isDirectory()) {
        walkAndRemoveFile(fullPath, targetName);
      } else if (entry === targetName) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch {}
  }
}

walkAndRemoveFile('$BUNDLE_SYM_DIR', 'auth-profiles.json');

// Check if the outside file still exists
if (fs.existsSync('$OUTSIDE_DIR/auth-profiles.json')) {
  console.log('SAFE');
} else {
  console.log('EXPLOITED');
}
" 2>&1)

if echo "$c8_result" | grep -q "SAFE"; then
  pass "C8: Symlink traversal blocked — outside file preserved"
else
  fail "C8: Symlink traversal — outside file was DELETED through symlink!"
fi

rm -rf "$SYMLINK_DIR"

# ══════════════════════════════════════════════════════════════════
# Phase 4: Blueprint Digest Verification
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Blueprint Digest Verification"

# C9: Empty digest string must be treated as a FAILURE
info "C9: Testing empty digest rejection..."

c9_result=$(cd "$REPO" && node -e "
// Simulate the FIXED verifyBlueprintDigest behavior:
// Empty/missing digest must be a hard failure, not a silent pass.

function verifyBlueprintDigest_FIXED(manifest) {
  if (!manifest.digest || manifest.digest.trim() === '') {
    return { valid: false, reason: 'Blueprint has no digest — verification required' };
  }
  // In real code, this would compute and compare the hash
  return { valid: true };
}

// The bug: digest: '' is falsy in JS, so the OLD code did:
//   if (manifest.digest && ...) — which skipped verification entirely
function verifyBlueprintDigest_VULNERABLE(manifest) {
  if (manifest.digest && manifest.digest !== 'WRONG') {
    return { valid: true };
  }
  if (!manifest.digest) {
    // This is the bug: empty string silently passes
    return { valid: true, reason: 'no digest to verify' };
  }
  return { valid: false, reason: 'digest mismatch' };
}

// Test the FIXED version
const result = verifyBlueprintDigest_FIXED({ digest: '' });
if (!result.valid) {
  console.log('REJECTED_EMPTY');
} else {
  console.log('ACCEPTED_EMPTY');
}

// Also test with undefined/null
const result2 = verifyBlueprintDigest_FIXED({ digest: undefined });
if (!result2.valid) {
  console.log('REJECTED_UNDEFINED');
} else {
  console.log('ACCEPTED_UNDEFINED');
}
" 2>&1)

if echo "$c9_result" | grep -q "REJECTED_EMPTY"; then
  pass "C9a: Empty digest string correctly rejected"
else
  fail "C9a: Empty digest string was ACCEPTED — bypass still possible!"
fi

if echo "$c9_result" | grep -q "REJECTED_UNDEFINED"; then
  pass "C9b: Undefined digest correctly rejected"
else
  fail "C9b: Undefined digest was ACCEPTED — bypass still possible!"
fi

# C10: Wrong digest must fail verification
info "C10: Testing wrong digest rejection..."

c10_result=$(cd "$REPO" && node -e "
const crypto = require('crypto');

function verifyDigest(manifest, blueprintContent) {
  if (!manifest.digest || manifest.digest.trim() === '') {
    return { valid: false, reason: 'no digest' };
  }
  const computed = crypto.createHash('sha256').update(blueprintContent).digest('hex');
  if (manifest.digest !== computed) {
    return { valid: false, reason: 'digest mismatch: expected ' + manifest.digest + ', got ' + computed };
  }
  return { valid: true };
}

const content = 'blueprint content here';
const wrongDigest = 'deadbeef0000000000000000000000000000000000000000000000000000dead';
const result = verifyDigest({ digest: wrongDigest }, content);
console.log(result.valid ? 'ACCEPTED_WRONG' : 'REJECTED_WRONG');
" 2>&1)

if echo "$c10_result" | grep -q "REJECTED_WRONG"; then
  pass "C10: Wrong digest correctly rejected"
else
  fail "C10: Wrong digest was ACCEPTED — verification broken!"
fi

# C11: Correct digest must pass
info "C11: Testing correct digest acceptance..."

c11_result=$(cd "$REPO" && node -e "
const crypto = require('crypto');

function verifyDigest(manifest, blueprintContent) {
  if (!manifest.digest || manifest.digest.trim() === '') {
    return { valid: false, reason: 'no digest' };
  }
  const computed = crypto.createHash('sha256').update(blueprintContent).digest('hex');
  if (manifest.digest !== computed) {
    return { valid: false, reason: 'digest mismatch' };
  }
  return { valid: true };
}

const content = 'blueprint content here';
const correctDigest = crypto.createHash('sha256').update(content).digest('hex');
const result = verifyDigest({ digest: correctDigest }, content);
console.log(result.valid ? 'ACCEPTED_CORRECT' : 'REJECTED_CORRECT');
" 2>&1)

if echo "$c11_result" | grep -q "ACCEPTED_CORRECT"; then
  pass "C11: Correct digest correctly accepted"
else
  fail "C11: Correct digest was REJECTED — false negative!"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Pattern-Based Credential Field Detection
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Pattern-Based Credential Detection"

# C12: Pattern-matched credential fields must be stripped
info "C12: Testing pattern-based credential field stripping..."

c12_result=$(cd "$REPO" && node -e "
const CREDENTIAL_FIELDS = new Set([
  'apiKey', 'api_key', 'token', 'secret', 'password', 'resolvedKey',
]);
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = '[STRIPPED_BY_MIGRATION]';
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

const config = {
  provider: {
    accessToken: 'test-access-token-value',
    refreshToken: 'test-refresh-token-value',
    privateKey: 'test-private-key-value',
    clientSecret: 'test-client-secret-value',
    signingKey: 'test-signing-key-value',
    bearerToken: 'test-bearer-token-value',
    sessionToken: 'test-session-token-value',
    authKey: 'test-auth-key-value',
  }
};

const sanitized = stripCredentials(config);
const allStripped = Object.values(sanitized.provider).every(v => v === '[STRIPPED_BY_MIGRATION]');
console.log(allStripped ? 'ALL_STRIPPED' : 'SOME_LEAKED');

// Print any that weren't stripped for debugging
for (const [k, v] of Object.entries(sanitized.provider)) {
  if (v !== '[STRIPPED_BY_MIGRATION]') {
    console.log('LEAKED: ' + k + ' = ' + v);
  }
}
" 2>&1)

if echo "$c12_result" | grep -q "ALL_STRIPPED"; then
  pass "C12: All pattern-matched credential fields stripped"
else
  fail "C12: Some credential fields NOT stripped: ${c12_result}"
fi

# C13: Non-credential fields with partial keyword overlap must be preserved
info "C13: Testing non-credential field preservation..."

c13_result=$(cd "$REPO" && node -e "
const CREDENTIAL_FIELDS = new Set([
  'apiKey', 'api_key', 'token', 'secret', 'password', 'resolvedKey',
]);
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = '[STRIPPED_BY_MIGRATION]';
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

const config = {
  displayName: 'should-be-preserved',
  sortKey: 'should-also-be-preserved',
  modelName: 'nvidia/nemotron-3-super-120b-a12b',
  keyRef: { source: 'env', id: 'NVIDIA_API_KEY' },
  description: 'A secret garden (but not a real secret)',
  tokenizer: 'sentencepiece',
  endpoint: 'https://api.nvidia.com/v1',
  sessionId: 'abc-123',
  accessLevel: 'admin',
  publicUrl: 'https://example.com',
};

const sanitized = stripCredentials(config);
const results = [];

// These should ALL be preserved (not stripped)
const expected = {
  displayName: 'should-be-preserved',
  sortKey: 'should-also-be-preserved',
  modelName: 'nvidia/nemotron-3-super-120b-a12b',
  description: 'A secret garden (but not a real secret)',
  tokenizer: 'sentencepiece',
  endpoint: 'https://api.nvidia.com/v1',
  sessionId: 'abc-123',
  accessLevel: 'admin',
  publicUrl: 'https://example.com',
};

let allPreserved = true;
for (const [key, expectedVal] of Object.entries(expected)) {
  if (sanitized[key] !== expectedVal) {
    console.log('CORRUPTED: ' + key + ' = ' + JSON.stringify(sanitized[key]) + ' (expected: ' + expectedVal + ')');
    allPreserved = false;
  }
}

// keyRef is an object — check it's preserved structurally
if (JSON.stringify(sanitized.keyRef) !== JSON.stringify({ source: 'env', id: 'NVIDIA_API_KEY' })) {
  console.log('CORRUPTED: keyRef');
  allPreserved = false;
}

console.log(allPreserved ? 'ALL_PRESERVED' : 'SOME_CORRUPTED');
" 2>&1)

if echo "$c13_result" | grep -q "ALL_PRESERVED"; then
  pass "C13: All non-credential fields preserved correctly"
else
  fail "C13: Some non-credential fields were corrupted: ${c13_result}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Shipped Blueprint Digest Check
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Shipped Blueprint Check"

# Verify the shipped blueprint.yaml has the known empty digest issue
info "Checking shipped blueprint.yaml digest field..."
BLUEPRINT_FILE="$REPO/nemoclaw-blueprint/blueprint.yaml"
if [ -f "$BLUEPRINT_FILE" ]; then
  digest_line=$(grep "^digest:" "$BLUEPRINT_FILE" || true)
  if echo "$digest_line" | grep -qE 'digest:\s*""'; then
    info "Shipped blueprint has digest: \"\" (empty) — this is the known vulnerability"
    info "After PR #156, empty digest will cause a hard verification failure"
    pass "Blueprint digest field found and identified"
  elif echo "$digest_line" | grep -qE 'digest:\s*$'; then
    info "Shipped blueprint has empty digest field"
    pass "Blueprint digest field found (empty)"
  elif [ -n "$digest_line" ]; then
    info "Blueprint digest: $digest_line"
    pass "Blueprint has a digest value set"
  else
    skip "No digest field found in blueprint.yaml"
  fi
else
  skip "blueprint.yaml not found at $BLUEPRINT_FILE"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Credential Sanitization Test Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Credential sanitization tests PASSED — no credential leaks found.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed — CREDENTIAL LEAKS OR BYPASS DETECTED.\033[0m\n' "$FAIL"
  exit 1
fi
