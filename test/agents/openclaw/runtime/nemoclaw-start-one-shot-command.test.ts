// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const JSON5_MODULE = path.resolve(import.meta.dirname, "../../../../nemoclaw/node_modules/json5");

describe("nemoclaw-start one-shot command setup", () => {
  it("reads the live gateway port from strict JSON and JSON5 config", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-gateway-port-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const scriptPath = path.join(tmpDir, "read-configured-gateway-port.sh");
    const readConfiguredGatewayPort = extractShellFunctionFromSource(
      source,
      "_read_configured_gateway_port",
    )
      .replaceAll("/opt/nemoclaw/node_modules/json5", JSON5_MODULE)
      .replaceAll(
        'config_path="/sandbox/.openclaw/openclaw.json"',
        'config_path="${NEMOCLAW_TEST_CONFIG_PATH:?}"',
      );
    fs.writeFileSync(scriptPath, `${readConfiguredGatewayPort}\n_read_configured_gateway_port\n`, {
      mode: 0o700,
    });
    const readPort = () =>
      spawnSync("bash", ["--noprofile", "--norc", scriptPath], {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_TEST_CONFIG_PATH: configPath },
        killSignal: "SIGKILL",
        timeout: 5000,
      });

    try {
      fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: 18791 } }));
      const strictJson = readPort();
      expect(strictJson.status, strictJson.stderr).toBe(0);
      expect(strictJson.stdout).toBe("18791");

      fs.writeFileSync(configPath, "{ gateway: { port: 18792, }, }\n");
      const json5 = readPort();
      expect(json5.status, json5.stderr).toBe(0);
      expect(json5.stdout).toBe("18792");

      fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: 80 } }));
      expect(readPort().status).not.toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("requires early gateway tokens only for gateway and OpenClaw commands (#3256)", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const script = [
      "set -euo pipefail",
      extractShellFunctionFromSource(source, "needs_gateway_token_for_current_command"),
      'check() { NEMOCLAW_CMD=("$@"); if needs_gateway_token_for_current_command; then printf "yes:%s\\n" "${1:-<none>}"; else printf "no:%s\\n" "${1:-<none>}"; fi; }',
      "check",
      "check openclaw agent --agent main",
      "check /usr/local/bin/openclaw agent --agent main",
      "check true",
      "check bash -lc 'openclaw agent --agent main'",
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("yes:<none>");
    expect(result.stdout).toContain("yes:openclaw");
    expect(result.stdout).toContain("yes:/usr/local/bin/openclaw");
    expect(result.stdout).toContain("no:true");
    expect(result.stdout).toContain("no:bash");
  });

  it("refreshes startup tokens but only ensures direct OpenClaw command tokens (#4517)", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const script = [
      "set -euo pipefail",
      extractShellFunctionFromSource(source, "needs_gateway_token_for_current_command"),
      extractShellFunctionFromSource(source, "prepare_gateway_token_for_current_command"),
      'ensure_gateway_token() { printf "rotate:%s\\n" "${NEMOCLAW_CMD[*]:-<none>}"; }',
      'ensure_gateway_token_if_missing() { printf "ensure-missing:%s\\n" "${NEMOCLAW_CMD[*]}"; }',
      'check() { NEMOCLAW_CMD=("$@"); prepare_gateway_token_for_current_command; }',
      "check",
      "check openclaw agent --agent main",
      "check true",
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rotate:<none>");
    expect(result.stdout).toContain("ensure-missing:openclaw agent --agent main");
    expect(result.stdout).not.toContain("true");
  });
});
