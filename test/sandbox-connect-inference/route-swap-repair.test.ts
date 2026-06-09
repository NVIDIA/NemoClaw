// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../helpers/timeouts";
import { createVmRootfs, isHostWsl, runConnect, setupFixture } from "./helpers";

describe("sandbox connect inference route swap (#1248)", () => {
  it(
    "skips the vLLM model preflight on connect --probe-only but keeps it for a full connect (#4585)",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );
      const bogus = { NEMOCLAW_VLLM_MODEL: "definitely-not-a-real-vllm-model" };
      const PREFLIGHT_HINT = "NEMOCLAW_VLLM_MODEL is consumed by";

      // probe-only / recover never install or serve a model, so the express-vLLM
      // model preflight must be skipped rather than hard-exiting the probe.
      const probe = runConnect(fixture.tmpDir, fixture.sandboxName, bogus, ["--probe-only"]);
      const probeOut = (probe.stdout || "") + (probe.stderr || "");
      // probe-only must proceed (not just avoid the hint): a non-zero exit would
      // mean it failed for some other reason before the skipped preflight.
      expect(probe.status).toBe(0);
      expect(probeOut).not.toContain(PREFLIGHT_HINT);

      // A full connect still runs the preflight and fails fast on the bogus value.
      const full = runConnect(fixture.tmpDir, fixture.sandboxName, bogus, []);
      const fullOut = (full.stdout || "") + (full.stderr || "");
      expect(full.status).toBe(1);
      expect(fullOut).toContain(PREFLIGHT_HINT);
    },
  );

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
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.inferenceSetCalls[0]).toEqual([
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
    "warns and aligns the route even in --probe-only quiet mode (#3726)",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-diverged-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("differs from the recorded route");
      expect(combined).toContain("Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514");
      expect(state.inferenceSetCalls).toContainEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);
      expect(state.sandboxConnectCalls).toEqual([]);
    },
  );

  it(
    "does not swap inference route for legacy sandbox without provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "legacy-sandbox",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "does not swap when live route already matches sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "matched-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "repairs the kubernetes sandbox DNS proxy when inference.local returns 503",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "stale-dns-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "kubernetes",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const dockerCalls = state.dockerCalls as string[][];
      const inferenceExecCalls = state.sandboxExecCalls.filter((call: string[]) =>
        JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(dockerCalls.some((call) => call.join(" ").includes("get service kube-dns"))).toBe(
        true,
      );
      expect(dockerCalls.some((call) => call.join(" ").includes("get endpoints kube-dns"))).toBe(
        false,
      );

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("inference.local is unavailable inside 'stale-dns-sandbox'");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "uses the VM DNS monkeypatch without legacy DNS repair or route reset when it restores inference.local",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-dns-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "vm",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );
      const rootfs = createVmRootfs(tmpDir);

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(state.dockerCalls.length).toBe(0);
      expect(fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8")).toBe(
        "nameserver 192.168.127.1\n",
      );
      expect(
        fs.readFileSync(path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"), "utf-8"),
      ).toContain("nameserver ${GVPROXY_GATEWAY_IP}");

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Applying OpenShell VM DNS monkeypatch");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Reapplying OpenShell inference route");
      expect(combined).not.toContain("Repairing sandbox DNS proxy");
    },
  );

  it(
    "stops before sandbox connect when inference.local is still broken after route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "still-broken-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("inference.local is still unavailable");
      expect(combined).toContain(
        "Connect is stopping because the sandbox inference route is known to be broken",
      );
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
        ["--provider", "ollama-local", "--model", "qwen3:0.6b", "--no-verify", "--timeout", "321"],
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
    testTimeoutOptions(20_000),
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
        ["--provider", "ollama-local", "--model", "qwen3:0.6b", "--no-verify", "--timeout", "180"],
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
