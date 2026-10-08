// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { renderWindowsMxcOpenClawProbeAgent } from "../live/windows-mxc-openclaw-process-container-helpers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Windows MXC OpenClaw proxy environment", () => {
  it.each([undefined, "", "*", "localhost,example.com"])(
    "routes only the bound mock endpoint directly with inherited NO_PROXY=%s (#8178)",
    (inheritedNoProxy) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mxc-proxy-contract-"));
      roots.push(root);
      const agentPath = path.join(root, "probe-agent.mjs");
      const entryPath = path.join(root, "fake-gateway.mjs");
      const preloadPath = path.join(root, "preload.mjs");
      const observationPath = path.join(root, "child-observation.json");
      const stopPath = path.join(root, "stop.txt");
      const proxy = "http://fixture-user:fixture-password@127.0.0.1:18080";
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.7.1" }));
      fs.writeFileSync(agentPath, renderWindowsMxcOpenClawProbeAgent());
      fs.writeFileSync(preloadPath, "export {};\n");
      fs.writeFileSync(
        entryPath,
        `import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const baseUrl = config.models.providers.mock.baseUrl;
const response = await fetch(baseUrl + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock-chat", messages: [{ role: "user", content: "probe" }] }),
});
writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  baseUrl, status: response.status, chat: await response.json(),
  env: Object.fromEntries(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]])),
}));
console.log("[gateway] ready");
writeFileSync(${JSON.stringify(stopPath)}, "stop");
setInterval(() => {}, 1000);
`,
      );

      const executed = spawnSync(process.execPath, [agentPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HTTP_PROXY: proxy,
          http_proxy: proxy,
          HTTPS_PROXY: proxy,
          https_proxy: proxy,
          NO_PROXY: inheritedNoProxy,
          no_proxy: inheritedNoProxy,
          NEMOCLAW_MXC_E2E_COMPAT_PRELOAD: preloadPath,
          NEMOCLAW_MXC_E2E_DENY_PATH: path.join(root, "missing-parent", "denied.txt"),
          NEMOCLAW_MXC_E2E_ENTRY: entryPath,
          NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: path.join(root, "heartbeat.txt"),
          NEMOCLAW_MXC_E2E_HOME: path.join(root, "probe-home"),
          NEMOCLAW_MXC_E2E_LOCAL_APP_DATA: path.join(root, "local-app-data"),
          NEMOCLAW_MXC_E2E_MOCK_PORT: "0",
          NEMOCLAW_MXC_E2E_NODE: process.execPath,
          NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: path.join(root, "openclaw.pid"),
          NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR: path.join(root, "state"),
          NEMOCLAW_MXC_E2E_OPENCLAW_PORT: "0",
          NEMOCLAW_MXC_E2E_OUTCOME_PATH: path.join(root, "outcome.json"),
          NEMOCLAW_MXC_E2E_READY_PATH: path.join(root, "ready.json"),
          NEMOCLAW_MXC_E2E_RESULT_PATH: path.join(root, "result.json"),
          NEMOCLAW_MXC_E2E_STOP_PATH: stopPath,
          NEMOCLAW_MXC_E2E_TEMP: path.join(root, "temp"),
          NEMOCLAW_MXC_E2E_TOKEN: "fixture-token",
        },
        timeout: 15_000,
        windowsHide: true,
      });

      expect(executed.status, executed.stderr).toBe(0);
      const observation = JSON.parse(fs.readFileSync(observationPath, "utf8"));
      const endpoint = new URL(observation.baseUrl);
      expect(endpoint.hostname).toBe("127.0.0.1");
      expect(Number(endpoint.port)).toBeGreaterThan(0);
      expect(observation.env).toEqual({
        HTTP_PROXY: proxy,
        http_proxy: proxy,
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        NO_PROXY: endpoint.host,
        no_proxy: endpoint.host,
      });
      expect(observation.status).toBe(200);
      expect(observation.chat.choices[0].message.content).toBe("CHAT_OK");
      expect(JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8"))).toMatchObject({
        startupReadyObserved: true,
        deniedWrite: true,
        versionExitCode: 0,
      });
    },
  );
});
