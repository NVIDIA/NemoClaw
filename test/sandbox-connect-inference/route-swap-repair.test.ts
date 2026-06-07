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
        "nvidia-prod", // live route points to a different provider
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
      expect(combined).toContain(
        "Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514",
      );
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
        "nvidia-prod", // live gateway route differs from the recorded route
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Divergence warning is emitted even though the probe path runs quiet.
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("differs from the recorded route");
      expect(combined).toContain(
        "Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514",
      );
      // Gateway is still re-pointed to the recorded route...
      expect(state.inferenceSetCalls).toContainEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);
      // ...and probe-only never opens an SSH session.
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
          // No provider or model — pre-v0.0.18 sandbox
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
      const inferenceExecCalls = state.sandboxExecCalls.filter(
        (call: string[]) =>
          JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get service kube-dns"),
        ),
      ).toBe(true);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get endpoints kube-dns"),
        ),
      ).toBe(false);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "inference.local is unavailable inside 'stale-dns-sandbox'",
      );
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "recovers the route via inference set for docker sandboxes without the legacy cluster repair (#3403)",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "docker-route-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "docker",
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
      // The docker driver has no openshell-cluster container (the gateway runs
      // as nemoclaw-openshell-gateway with host networking), so it must NOT take
      // the legacy CoreDNS cluster repair; it recovers via `inference set`. (#3403)
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get service kube-dns"),
        ),
      ).toBe(false);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Could not find gateway container");
    },
  );

  it(
    "does not run legacy DNS proxy repair for VM sandboxes",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-sandbox",
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
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(2);
      expect(state.dockerCalls.length).toBe(0);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("OpenShell VM DNS monkeypatch did not apply");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("OpenShell vm gateway path");
      expect(combined).toContain(
        "Connect is stopping because the sandbox inference route is known to be broken",
      );
    },
  );

  it(
    "uses the macOS VM DNS monkeypatch without legacy DNS repair or route reset when it restores inference.local",
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
      expect(
        fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8"),
      ).toBe("nameserver 192.168.127.1\n");
      expect(
        fs.readFileSync(
          path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"),
          "utf-8",
        ),
      ).toContain("nameserver ${GVPROXY_GATEWAY_IP}");

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Applying OpenShell VM DNS monkeypatch");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Reapplying OpenShell inference route");
      expect(combined).not.toContain("Repairing sandbox DNS proxy");
    },
  );

  it(
    "falls back to OpenShell inference route reapply when the VM DNS monkeypatch applies but inference.local stays broken",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-dns-still-broken",
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
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
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
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.dockerCalls.length).toBe(0);
      expect(
        fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8"),
      ).toBe("nameserver 192.168.127.1\n");

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Applying OpenShell VM DNS monkeypatch");
      expect(combined).toContain(
        "OpenShell VM DNS monkeypatch completed but inference.local is still unavailable",
      );
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "probes VM inference health after route reapply even when inference set exits nonzero",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-route-set-nonzero",
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
          inferenceSetStatus: 1,
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

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
      expect(state.dockerCalls.length).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("OpenShell VM DNS monkeypatch did not apply");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("OpenShell vm gateway path");
    },
  );

  it(
    "repairs the sandbox DNS proxy when inference.local returns 000 with a non-zero probe exit",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "dns-000-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeExitStatuses: [1, 0],
          inferenceProbeResponses: ["BROKEN 000 ", "OK 200"],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const dockerCalls = state.dockerCalls as string[][];
      const inferenceExecCalls = state.sandboxExecCalls.filter(
        (call: string[]) =>
          JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get service kube-dns"),
        ),
      ).toBe(true);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "inference.local is unavailable inside 'dns-000-sandbox'",
      );
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "checks the Ollama auth proxy before local provider health during probe-only route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-only-ollama-sandbox",
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

      const nonWslPlatformPreload = path.join(
        tmpDir,
        "force-non-wsl-platform.cjs",
      );
      fs.writeFileSync(
        nonWslPlatformPreload,
        [
          'const os = require("node:os");',
          'Object.defineProperty(process, "platform", { value: "linux" });',
          'os.release = () => "6.8.0-generic";',
          "delete process.env.WSL_DISTRO_NAME;",
          "delete process.env.WSL_INTEROP;",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const result = runConnect(
        tmpDir,
        sandboxName,
        {
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --require=${nonWslPlatformPreload}`.trim(),
        },
        ["--probe-only"],
      );
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const endpoints = (state.curlCalls as string[][]).map(
        (call) => call[call.length - 1],
      );
      const backendIndexes = endpoints
        .map((endpoint, index) =>
          endpoint.includes("127.0.0.1:11434/api/tags") ? index : -1,
        )
        .filter((index) => index >= 0);
      const firstProxyIndex = endpoints.findIndex(
        (endpoint) =>
          endpoint.includes("127.0.0.1:11435/v1/models") ||
          endpoint.includes("localhost:11435/v1/models"),
      );
      expect(firstProxyIndex).toBeGreaterThanOrEqual(0);
      expect(backendIndexes.length).toBeGreaterThanOrEqual(2);
      expect(firstProxyIndex).toBeLessThan(backendIndexes[1]);
    },
  );

  it(
    "resets matching inference route when DNS repair leaves inference.local broken",
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
      const inferenceExecCalls = state.sandboxExecCalls.filter(
        (call: string[]) =>
          JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "ollama-local",
          "--model",
          "qwen3:0.6b",
          "--no-verify",
          "--timeout",
          "321",
        ],
      ]);
      expect(inferenceExecCalls.length).toBe(5);
      if (!isHostWsl()) {
        expect(
          curlCalls.some((call) =>
            call.join(" ").includes("127.0.0.1:11435/v1/models"),
          ),
        ).toBe(true);
      }
      expect(curlCalls.flat().join(" ")).not.toContain("Authorization: Bearer");
      for (const [index, call] of curlCalls.entries()) {
        const endpoint = call[call.length - 1];
        if (!endpoint.includes("127.0.0.1") && !endpoint.includes("localhost"))
          continue;
        const proxyBypass = `${curlEnvs[index]?.NO_PROXY || ""},${curlEnvs[index]?.no_proxy || ""}`;
        expect(proxyBypass).toContain("127.0.0.1");
        expect(proxyBypass).toContain("localhost");
        expect(curlEnvs[index]?.ALL_PROXY || "").toBe("");
      }

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "Resetting inference route to ollama-local/qwen3:0.6b",
      );
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "probes route health before failing a non-zero managed route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "managed-route-set-nonzero",
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
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
          inferenceSetStatus: 1,
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const inferenceExecCalls = state.sandboxExecCalls.filter(
        (call: string[]) =>
          JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(inferenceExecCalls.length).toBe(5);
      expect(state.sandboxConnectCalls).toEqual([
        ["sandbox", "connect", sandboxName],
      ]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "Resetting inference route to nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
      );
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain(
        "failed to reset the OpenShell inference route",
      );
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
    "diagnoses host Ollama before resetting a broken ollama-local route",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "ollama-down-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          curlExitCode: 7,
          curlHttpStatus: "000",
          curlStderr: "curl: (7) Failed to connect to 127.0.0.1 port 11434\n",
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
          ],
          writeOllamaProxyState: false,
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls).toEqual([]);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Local Ollama is selected for inference");
      expect(combined).toContain("Start Ollama and retry");
      expect(combined).toContain(
        "Connect is stopping because the sandbox inference route is known to be broken",
      );
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
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --require=${wslPlatformPreload}`.trim(),
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
        .map((call, index) =>
          call.join(" ").includes("host.docker.internal:11434") ? index : -1,
        )
        .filter((index) => index >= 0);
      expect(state.inferenceSetCalls).toEqual([
        [
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
      expect(state.sandboxConnectCalls).toEqual([
        ["sandbox", "connect", sandboxName],
      ]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "Resetting inference route to ollama-local/qwen3:0.6b",
      );
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Ollama auth proxy token is missing");
    },
  );
});
