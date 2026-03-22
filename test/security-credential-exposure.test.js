// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security tests for migration credential sanitization.
// Verifies that the sanitization logic correctly strips credentials from
// migration bundles before they enter the sandbox.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Deliberately non-matching fake tokens that will NOT trigger secret scanners.
// These do NOT follow real token formats (no "ghp_", "nvapi-", "npm_" prefixes).
const FAKE_NVIDIA_KEY = "test-fake-nvidia-key-0000000000000000";
const FAKE_GITHUB_TOKEN = "test-fake-github-token-1111111111111111";
const FAKE_NPM_TOKEN = "test-fake-npm-token-2222222222222222";
const FAKE_GATEWAY_TOKEN = "test-fake-gateway-token-333333333333";

// SYNC REQUIRED: if CREDENTIAL_FIELDS, CREDENTIAL_FIELD_PATTERN, stripCredentials,
// or walkAndRemoveFile change in migration-state.ts, update the copies here.
// Divergence is a silent false-pass bug.
const CREDENTIAL_FIELDS = new Set([
  "apiKey", "api_key", "token", "secret", "password", "resolvedKey",
]);
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

/** Local reimplementation of stripCredentials for test isolation. */
function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = "[STRIPPED_BY_MIGRATION]";
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
    } catch { /* non-fatal */ }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helper: create a mock ~/.openclaw directory with credential files
// ═══════════════════════════════════════════════════════════════════
/** Create a mock ~/.openclaw directory tree populated with fake credential files. */
function createMockOpenClawHome(tmpDir) {
  const stateDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });

  const config = {
    agents: {
      defaults: {
        model: { primary: "nvidia/nemotron-3-super-120b-a12b" },
        workspace: path.join(stateDir, "workspace"),
      },
    },
    gateway: {
      mode: "local",
      auth: { token: FAKE_GATEWAY_TOKEN },
    },
    nvidia: { apiKey: FAKE_NVIDIA_KEY },
  };
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
  );

  const authDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(authDir, { recursive: true });
  const authProfiles = {
    "nvidia:manual": {
      type: "api_key",
      provider: "nvidia",
      keyRef: { source: "env", id: "NVIDIA_API_KEY" },
      resolvedKey: FAKE_NVIDIA_KEY,
      profileId: "nvidia:manual",
    },
    "github:pat": {
      type: "api_key",
      provider: "github",
      token: FAKE_GITHUB_TOKEN,
      profileId: "github:pat",
    },
    "npm:publish": {
      type: "api_key",
      provider: "npm",
      token: FAKE_NPM_TOKEN,
      profileId: "npm:publish",
    },
  };
  fs.writeFileSync(
    path.join(authDir, "auth-profiles.json"),
    JSON.stringify(authProfiles, null, 2),
  );

  const workspace = path.join(stateDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "project.md"), "# My Project\n");

  return { stateDir, config, authProfiles };
}

// ═══════════════════════════════════════════════════════════════════
// 1. Sanitization deletes auth-profiles.json and strips config tokens
// ═══════════════════════════════════════════════════════════════════
describe("Migration credential sanitization", () => {
  it("deletes auth-profiles.json and strips credential fields from openclaw.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-"));
    try {
      const mock = createMockOpenClawHome(tmpDir);

      // Simulate snapshot copy
      const bundleDir = path.join(tmpDir, "bundle", "openclaw");
      fs.cpSync(mock.stateDir, bundleDir, { recursive: true });

      // Apply sanitization (mirrors production sanitizeCredentialsInBundle)
      const agentsDir = path.join(bundleDir, "agents");
      if (fs.existsSync(agentsDir)) {
        walkAndRemoveFile(agentsDir, "auth-profiles.json");
      }

      const configPath = path.join(bundleDir, "openclaw.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      fs.writeFileSync(configPath, JSON.stringify(stripCredentials(config), null, 2));

      // Verify: auth-profiles.json deleted
      const authPath = path.join(bundleDir, "agents", "main", "agent", "auth-profiles.json");
      assert.ok(!fs.existsSync(authPath), "auth-profiles.json must be deleted");

      // Verify: credential fields stripped
      const sanitized = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      assert.strictEqual(sanitized.nvidia.apiKey, "[STRIPPED_BY_MIGRATION]");
      assert.strictEqual(sanitized.gateway.auth.token, "[STRIPPED_BY_MIGRATION]");

      // Verify: non-credential fields preserved
      assert.strictEqual(sanitized.agents.defaults.model.primary, "nvidia/nemotron-3-super-120b-a12b");
      assert.strictEqual(sanitized.gateway.mode, "local");

      // Verify: workspace files untouched
      assert.ok(fs.existsSync(path.join(bundleDir, "workspace", "project.md")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("strips credential fields matched by pattern (e.g. accessToken, privateKey)", () => {
    const config = {
      provider: {
        accessToken: "test-access-token-value",
        refreshToken: "test-refresh-token-value",
        privateKey: "test-private-key-value",
        clientSecret: "test-client-secret-value",
        displayName: "should-be-preserved",
        sortKey: "should-also-be-preserved",
      },
    };

    const sanitized = stripCredentials(config);

    assert.strictEqual(sanitized.provider.accessToken, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.provider.refreshToken, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.provider.privateKey, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.provider.clientSecret, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.provider.displayName, "should-be-preserved");
    assert.strictEqual(sanitized.provider.sortKey, "should-also-be-preserved");
  });

  it("skips symlinks during credential sanitization walk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-symlink-"));
    try {
      // Create a real auth-profiles.json outside the bundle
      const outsideDir = path.join(tmpDir, "outside");
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideAuth = path.join(outsideDir, "auth-profiles.json");
      fs.writeFileSync(outsideAuth, JSON.stringify({ shouldNotBeDeleted: true }));

      // Create bundle with symlink pointing to outside
      const bundleDir = path.join(tmpDir, "bundle");
      const agentsDir = path.join(bundleDir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.symlinkSync(outsideAuth, path.join(agentsDir, "auth-profiles.json"));

      // Walk should skip the symlink
      walkAndRemoveFile(agentsDir, "auth-profiles.json");

      // The outside file should still exist (symlink was skipped)
      assert.ok(fs.existsSync(outsideAuth), "file outside bundle must not be deleted via symlink");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("strips all value types when key matches (not just strings/objects)", () => {
    const config = {
      token: 12345,         // number — isCredentialField fires before recursive call
      secret: true,         // boolean — same
      password: null,       // null — isCredentialField fires first; early-return is NOT reached
      apiKey: "string-val", // string
      normalField: "keep",
    };

    const sanitized = stripCredentials(config);
    assert.strictEqual(sanitized.token, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.secret, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.password, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.apiKey, "[STRIPPED_BY_MIGRATION]");
    assert.strictEqual(sanitized.normalField, "keep");
  });
});
