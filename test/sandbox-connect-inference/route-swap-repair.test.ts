// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../helpers/timeouts";
import { isHostWsl, runConnect, setupFixture } from "./helpers";

describe("sandbox connect inference route swap (#1248)", () => {
  it(
    "swaps inference route when live route does not match sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceGetCalls).toEqual([["-g", "nemoclaw"]]);
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.inferenceSetCalls[0]).toEqual([
        "-g",
        "nemoclaw",
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);

      // Override must be loud (#3726), not a silent status-style line.
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("differs from the recorded route");
      expect(combined).toContain("Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514");
    },
  );

  it(
    "resets local Ollama routes without leaking proxy env or bearer tokens",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "stale-route-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        ALL_PROXY: "http://127.0.0.1:9",
        NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "321",
        NO_PROXY: "",
        http_proxy: "http://127.0.0.1:9",
        no_proxy: "",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const curlCalls = state.curlCalls as string[][];
      const curlEnvs = state.curlEnvs as Record<string, string>[];
      expect(state.inferenceSetCalls).toEqual([
        [
          "-g",
          "nemoclaw",
          "--provider",
          "ollama-local",
          "--model",
          "qwen3:0.6b",
          "--no-verify",
          "--timeout",
          "321",
        ],
      ]);
      if (!isHostWsl()) {
        expect(curlCalls.some((call) => call.join(" ").includes("127.0.0.1:11435/v1/models"))).toBe(
          true,
        );
      }
      expect(curlCalls.flat().join(" ")).not.toContain("Authorization: Bearer");
      for (const [index, call] of curlCalls.entries()) {
        const endpoint = call[call.length - 1];
        if (!endpoint.includes("127.0.0.1") && !endpoint.includes("localhost")) {
          continue;
        }
        const proxyBypass = `${curlEnvs[index]?.NO_PROXY || ""},${curlEnvs[index]?.no_proxy || ""}`;
        expect(proxyBypass).toContain("127.0.0.1");
        expect(proxyBypass).toContain("localhost");
        expect(curlEnvs[index]?.ALL_PROXY || "").toBe("");
      }
    },
  );

  it(
    "repairs WSL ollama-local routes without requiring the auth proxy",
    testTimeoutOptions(40_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "wsl-ollama-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
          writeOllamaProxyState: false,
        },
      );

      const wslPlatformPreload = path.join(tmpDir, "force-wsl-platform.cjs");
      fs.writeFileSync(
        wslPlatformPreload,
        'Object.defineProperty(process, "platform", { value: "linux" });\n',
        { mode: 0o600 },
      );
      const result = runConnect(tmpDir, sandboxName, {
        ALL_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${wslPlatformPreload}`.trim(),
        NO_PROXY: "",
        OPENSHELL_TEST_FAIL_LOCALHOST_OLLAMA: "1",
        WSL_DISTRO_NAME: "Ubuntu",
        no_proxy: "",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const curlCalls = state.curlCalls as string[][];
      const curlEnvs = state.curlEnvs as Record<string, string>[];
      const windowsHostIndexes = curlCalls
        .map((call, index) => (call.join(" ").includes("host.docker.internal:11434") ? index : -1))
        .filter((index) => index >= 0);
      expect(state.inferenceSetCalls).toEqual([
        [
          "-g",
          "nemoclaw",
          "--provider",
          "ollama-local",
          "--model",
          "qwen3:0.6b",
          "--no-verify",
          "--timeout",
          "180",
        ],
      ]);
      expect(windowsHostIndexes.length).toBeGreaterThan(0);
      for (const index of windowsHostIndexes) {
        const proxyBypass = `${curlEnvs[index]?.NO_PROXY || ""},${curlEnvs[index]?.no_proxy || ""}`;
        expect(proxyBypass).toContain("host.docker.internal");
        expect(curlEnvs[index]?.ALL_PROXY || "").toBe("");
      }
      expect(state.sandboxConnectCalls).toEqual([["sandbox", "connect", sandboxName]]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Resetting inference route to ollama-local/qwen3:0.6b");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Ollama auth proxy token is missing");
    },
  );
});
