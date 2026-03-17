// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const PYTHON_SCRIPT = path.join(SCRIPTS_DIR, "write-openclaw-gateway-config.py");

function runGatewayConfigScript(env = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
  const configPath = path.join(configDir, "openclaw.json");
  const fullEnv = { ...process.env, OPENCLAW_JSON_PATH: configPath, ...env };
  try {
    execSync(`python3 "${PYTHON_SCRIPT}"`, { env: fullEnv, encoding: "utf-8" });
    const content = fs.readFileSync(configPath, "utf-8");
    return { config: JSON.parse(content), configPath };
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

describe("write-openclaw-gateway-config.py (remote dashboard bind)", () => {
  it("sets gateway.bind to lan by default for remote access", () => {
    const { config } = runGatewayConfigScript();
    expect(config.gateway?.bind).toBe("lan");
  });

  it("honors GATEWAY_BIND=loopback", () => {
    const { config } = runGatewayConfigScript({ GATEWAY_BIND: "loopback" });
    expect(config.gateway?.bind).toBe("loopback");
  });

  it("includes local and CHAT_UI_URL origins in allowedOrigins", () => {
    const { config } = runGatewayConfigScript({
      CHAT_UI_URL: "http://my-host:18789",
      PUBLIC_PORT: "18789",
    });
    const origins = config.gateway?.controlUi?.allowedOrigins ?? [];
    expect(origins).toContain("http://127.0.0.1:18789");
    expect(origins).toContain("http://my-host:18789");
  });

  it("sets dangerouslyDisableDeviceAuth for sandbox so websocket works over port-forward", () => {
    const { config } = runGatewayConfigScript();
    expect(config.gateway?.controlUi?.dangerouslyDisableDeviceAuth).toBe(true);
  });
});
