// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const PYTHON_SCRIPT = path.join(SCRIPTS_DIR, "write-openclaw-gateway-config.py");

function runGatewayConfigScript(env = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
  const configPath = path.join(configDir, "openclaw.json");
  const fullEnv = { ...process.env, OPENCLAW_JSON_PATH: configPath, ...env };
  execSync(`python3 "${PYTHON_SCRIPT}"`, { env: fullEnv, encoding: "utf-8" });
  const content = fs.readFileSync(configPath, "utf-8");
  fs.rmSync(configDir, { recursive: true, force: true });
  return { config: JSON.parse(content), configPath };
}

describe("write-openclaw-gateway-config.py (remote dashboard bind)", () => {
  it("sets gateway.bind to lan by default for remote access", () => {
    const { config } = runGatewayConfigScript();
    assert.equal(config.gateway?.bind, "lan");
  });

  it("honors GATEWAY_BIND=loopback", () => {
    const { config } = runGatewayConfigScript({ GATEWAY_BIND: "loopback" });
    assert.equal(config.gateway?.bind, "loopback");
  });

  it("includes local and CHAT_UI_URL origins in allowedOrigins", () => {
    const { config } = runGatewayConfigScript({
      CHAT_UI_URL: "http://my-host:18789",
      PUBLIC_PORT: "18789",
    });
    const origins = config.gateway?.controlUi?.allowedOrigins ?? [];
    assert.ok(origins.includes("http://127.0.0.1:18789"), "local origin present");
    assert.ok(origins.includes("http://my-host:18789"), "remote CHAT_UI_URL origin present");
  });

  it("sets dangerouslyDisableDeviceAuth for sandbox so websocket works over port-forward", () => {
    const { config } = runGatewayConfigScript();
    assert.equal(config.gateway?.controlUi?.dangerouslyDisableDeviceAuth, true);
  });
});
