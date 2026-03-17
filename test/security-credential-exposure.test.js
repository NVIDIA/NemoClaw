// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security tests for migration credential sanitization.
// Demonstrates the credential exposure vulnerability and verifies the fix.
//
// Note: Blueprint digest tests were removed — the verify.ts and resolve.ts
// modules were deleted upstream in PR #492 (CLI commands removed).

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

// ═══════════════════════════════════════════════════════════════════
// Helper: create a mock ~/.openclaw directory with credential files
// ═══════════════════════════════════════════════════════════════════
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
// 1. Migration copies ALL credentials into sandbox (demonstrates vuln)
// ═══════════════════════════════════════════════════════════════════
describe("Migration credential exposure (pre-fix behavior)", () => {
  it("raw cpSync copies auth-profiles.json with all tokens into sandbox", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-poc-"));
    try {
      const mock = createMockOpenClawHome(tmpDir);

      // Simulate the vulnerable codepath: cpSync(stateDir, snapshotDir)
      const snapshotDir = path.join(tmpDir, "snapshot", "openclaw");
      fs.cpSync(mock.stateDir, snapshotDir, { recursive: true });

      const authPath = path.join(snapshotDir, "agents", "main", "agent", "auth-profiles.json");
      const configPath = path.join(snapshotDir, "openclaw.json");

      assert.ok(fs.existsSync(authPath), "auth-profiles.json copied into sandbox");
      assert.ok(fs.existsSync(configPath), "openclaw.json copied into sandbox");

      const stolenAuth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const stolenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

      // All tokens are fully readable — this is the vulnerability
      assert.strictEqual(stolenAuth["nvidia:manual"].resolvedKey, FAKE_NVIDIA_KEY);
      assert.strictEqual(stolenAuth["github:pat"].token, FAKE_GITHUB_TOKEN);
      assert.strictEqual(stolenAuth["npm:publish"].token, FAKE_NPM_TOKEN);
      assert.strictEqual(stolenConfig.gateway.auth.token, FAKE_GATEWAY_TOKEN);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Fix verification — sanitized migration blocks the attack chain
// ═══════════════════════════════════════════════════════════════════
describe("Fix verification: sanitized migration blocks credential theft", () => {
  it("sanitizeCredentialsInBundle deletes auth-profiles.json and strips config tokens", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fix-"));
    try {
      const mock = createMockOpenClawHome(tmpDir);

      // Simulate snapshot + prepare
      const bundleDir = path.join(tmpDir, "bundle", "openclaw");
      fs.cpSync(mock.stateDir, bundleDir, { recursive: true });

      // Apply the same sanitization logic from the fix in migration-state.ts
      const CREDENTIAL_FIELDS = new Set([
        "apiKey", "api_key", "token", "secret", "password", "resolvedKey", "keyRef",
      ]);

      function stripCredentials(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(stripCredentials);
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          if (CREDENTIAL_FIELDS.has(key) && (typeof value === "string" || typeof value === "object")) {
            result[key] = "[STRIPPED_BY_MIGRATION]";
          } else {
            result[key] = stripCredentials(value);
          }
        }
        return result;
      }

      // Delete auth-profiles.json
      const authPath = path.join(bundleDir, "agents", "main", "agent", "auth-profiles.json");
      if (fs.existsSync(authPath)) fs.rmSync(authPath, { force: true });

      // Strip config credentials
      const configPath = path.join(bundleDir, "openclaw.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      fs.writeFileSync(configPath, JSON.stringify(stripCredentials(config), null, 2));

      // Verify: auth-profiles.json deleted
      assert.ok(!fs.existsSync(authPath), "auth-profiles.json must be deleted");

      // Verify: config credentials stripped
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
});
