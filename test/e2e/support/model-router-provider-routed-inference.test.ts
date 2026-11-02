// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveModelRouterLogPath } from "../../../src/lib/onboard/model-router.ts";
import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";

import { HostCliClient, type CommandRunner } from "../fixtures/clients/index.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import {
  buildProviderRoutedEnv,
  retainRouterDiagnostics,
  registerRouterDiagnostics,
  recordRouterFailureDiagnostics,
  ROUTER_PROVIDER_FAILURE_DIAGNOSTIC,
} from "../live/model-router-provider-routed-inference-helpers.ts";

// Model a test process configured for a different gateway than its filtered child.
vi.mock("../../../src/lib/core/ports.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/core/ports.ts")>()),
  GATEWAY_PORT: 9123,
}));

describe("Model Router provider-routed live support", () => {
  it.each([
    { mode: "response", outcome: "http-response", statuses: [200, 302], truncated: [false, false] },
    { mode: "timeout", outcome: "timeout", statuses: [null, null], truncated: [null, null] },
    { mode: "oversized", outcome: "http-response", statuses: [200, 302], truncated: [true, true] },
  ])(
    "retains bounded provider status and dependency versions without private text [$mode]",
    async ({ mode, outcome, statuses, truncated }) => {
      const pool = parseYaml(
        await fs.readFile(
          new URL("../../../nemoclaw-blueprint/router/pool-config.yaml", import.meta.url),
          "utf8",
        ),
      );
      const models = pool.models.map((model: { litellm_model: string }) =>
        model.litellm_model.replace(/^openai\//, ""),
      );
      const origins = pool.models.map(
        (model: { api_base: string }) => new URL(model.api_base).host,
      );
      const prelude = String.raw`
import http.client, importlib.metadata, json, os, sys
def deny_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise RuntimeError("unit test network denied")
sys.addaudithook(deny_network)
mode = ${JSON.stringify(mode)}
connections = []
expected_models = ${JSON.stringify(models)}
expected_origins = ${JSON.stringify(origins)}
class Response:
    def __init__(self, model):
        self.status = 200 if model.startswith("openai/") else 302
    def read(self, limit):
        assert limit == 65537
        if mode == "oversized":
            return b"x" * limit
        return json.dumps({"choices": [{"message": {"content": "private-response-text"}}], "error": "private-error-text"}).encode()
class Connection:
    def __init__(self, host, timeout):
        assert host == "integrate.api.nvidia.com" and timeout == 60
        self.closed = False
        connections.append(self)
    def request(self, method, url, body, headers):
        assert method == "POST" and url == "/v1/chat/completions"
        assert headers["Authorization"] == "Bearer " + os.environ["NVIDIA_INFERENCE_API_KEY"]
        payload = json.loads(body)
        assert payload["max_tokens"] == 1 and payload["stream"] is False
        self.model = payload["model"]
        assert self.model in expected_models
        assert all(origin == "integrate.api.nvidia.com" for origin in expected_origins)
    def getresponse(self):
        if mode == "timeout":
            raise TimeoutError("private-exception-text")
        return Response(self.model)
    def close(self):
        self.closed = True
http.client.HTTPSConnection = Connection
def version(package):
    if package == "aiohttp":
        raise RuntimeError("private-package-error")
    if package == "openai":
        return os.environ["NVIDIA_INFERENCE_API_KEY"]
    return "private-version / invalid" if package == "httpcore" else "1.2.3"
importlib.metadata.version = version
`;
      const result = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          prelude +
            ROUTER_PROVIDER_FAILURE_DIAGNOSTIC +
            "\nassert len(connections) == 2 and all(c.closed for c in connections)\nassert sorted(c.model for c in connections) == sorted(expected_models)\n",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { PATH: process.env.PATH ?? "", NVIDIA_INFERENCE_API_KEY: "nvapi-synthetic-probe" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/private-|nvapi-synthetic-probe/);
      const retained = JSON.parse(result.stdout);
      expect(retained.packages.httpcore).toBe("nonstandard-version");
      expect(retained.packages.openai).toBe("nonstandard-version");
      expect(retained.packages.aiohttp).toBeNull();
      expect(retained.results.map((item: { outcome: string }) => item.outcome)).toEqual([
        outcome,
        outcome,
      ]);
      // Redirect status is retained without following it; timeouts have no response metadata.
      expect(retained.results.map((item: { status?: number }) => item.status ?? null)).toEqual(
        statuses,
      );
      expect(
        retained.results.map((item: { truncated?: boolean }) => item.truncated ?? null),
      ).toEqual(truncated);
    },
  );

  it("runs diagnostics only after failure and preserves onboarding failure if diagnostics cannot run", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-provider-diagnostics-"));
    const calls: { command: string; args: string[]; options?: ShellProbeRunOptions }[] = [];
    const run = vi.fn(
      async (
        command: { command: string; args: readonly string[] },
        options?: ShellProbeRunOptions,
      ) => {
        calls.push({ command: command.command, args: [...command.args], options });
        return {
          command: [command.command, ...command.args],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "{}",
          stderr: "",
          artifacts: { stdout: "", stderr: "", result: "" },
        };
      },
    );
    const host = new HostCliClient({ run });
    const artifacts = new ArtifactSink(directory);
    const env = buildProviderRoutedEnv("nvapi-synthetic-probe", "e2e-router", {
      HOME: directory,
      NEMOCLAW_MODEL_ROUTER_VENV: "/unselected-venv",
    });
    try {
      await recordRouterFailureDiagnostics(host, artifacts, 0, env, ["nvapi-synthetic-probe"]);
      expect(calls).toHaveLength(0);
      await recordRouterFailureDiagnostics(host, artifacts, 1, env, ["nvapi-synthetic-probe"]);
      expect(calls).toHaveLength(1);
      expect(env.NEMOCLAW_MODEL_ROUTER_VENV).toBeUndefined();
      expect(calls[0].command).toBe(
        path.join(
          path.dirname(path.dirname(resolveModelRouterLogPath(directory, DEFAULT_GATEWAY_PORT))),
          "model-router-venv/bin/python",
        ),
      );
      expect(calls[0].args).toEqual(["-I", "-c", ROUTER_PROVIDER_FAILURE_DIAGNOSTIC]);
      expect(calls[0].args.join(" ")).not.toContain("nvapi-synthetic-probe");
      expect(calls[0].options).toEqual({
        artifactName: "router-provider-failure-diagnostics",
        env,
        redactionValues: ["nvapi-synthetic-probe"],
        captureLimitBytes: 8_192,
        timeoutMs: 75_000,
      });
      run.mockRejectedValueOnce(new Error("diagnostic runtime unavailable"));
      await recordRouterFailureDiagnostics(host, artifacts, 1, env, ["nvapi-synthetic-probe"]);
      expect(
        JSON.parse(
          await fs.readFile(artifacts.pathFor("router-provider-failure-diagnostics.json"), "utf8"),
        ),
      ).toEqual({ available: false });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("builds the routed onboard environment with both NVIDIA credential names", () => {
    expect(buildProviderRoutedEnv("nvapi-public-test-key", "e2e-router", {})).toMatchObject({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER_KEY: "nvapi-public-test-key",
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PROVIDER: "routed",
      NEMOCLAW_SANDBOX_NAME: "e2e-router",
    });
  });

  it("bounds and redacts container discovery only after routed onboarding fails", async () => {
    const calls: { command: string; args: string[]; options?: ShellProbeRunOptions }[] = [];
    const runner: CommandRunner = {
      async run(command, options) {
        calls.push({ command: command.command, args: [...command.args], options });
        return {
          command: [command.command, ...command.args],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          artifacts: { stdout: "", stderr: "", result: "" },
        };
      },
    };
    const host = new HostCliClient(runner);

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-model-router", 0);
    await host.recordSandboxContainerDiscoveryOnFailure("../foreign", 1);
    expect(calls).toEqual([]);

    await host.recordSandboxContainerDiscoveryOnFailure("e2e-model-router", 1, ["private-key"]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining(
        [
          ["label", "label=openshell.ai/sandbox-name=e2e-model-router"],
          ["name", "name=e2e-model-router"],
        ].map(([kind, filter]) => ({
          command: "docker",
          args: [
            "ps",
            "--all",
            "--no-trunc",
            "--filter",
            filter,
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Status}}",
          ],
          options: {
            artifactName: `sandbox-container-discovery-${kind}`,
            captureLimitBytes: 8_192,
            redactionValues: ["private-key"],
            timeoutMs: 5_000,
          },
        })),
      ),
    );
  });

  it("retains router status without request text or credentials", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const log = path.join(directory, "router.log");
      await fs.writeFile(
        log,
        [
          "Model Router Toolkit: strategy registered in 1.0s",
          "Warmup route : model",
          '127.0.0.1 - "POST /v1/chat/completions HTTP/1.1" 200 OK',
          "TimeoutError: private request text; Authorization: Bearer arbitrary-secret",
        ].join("\n"),
      );
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      await retainRouterDiagnostics(sink, log);
      const retained = JSON.parse(
        await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8"),
      );
      expect(retained).toEqual({
        available: true,
        truncated: false,
        strategyRegistered: true,
        warmupCompleted: true,
        warmupFailed: false,
        strategyInjectionFailed: false,
        timeoutReported: true,
        authenticationErrorReported: false,
        rateLimitReported: false,
        connectionErrorReported: false,
        completionResponses: 1,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds router log reads to the final 64 KiB", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      const log = path.join(directory, "router.log");
      await fs.writeFile(log, `AuthenticationError${"x".repeat(70_000)}RateLimitError`);
      await retainRouterDiagnostics(sink, log);
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toMatchObject({
        available: true,
        truncated: true,
        authenticationErrorReported: false,
        rateLimitReported: true,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: "symlink", prepare: (log: string, directory: string) => fs.symlink(directory, log) },
    { kind: "missing", prepare: async (_log: string, _directory: string) => {} },
    { kind: "directory", prepare: (log: string, _directory: string) => fs.mkdir(log) },
  ])("reports a $kind log as unavailable without error text", async ({ prepare }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      const log = path.join(directory, "router.log");
      await prepare(log, directory);
      await retainRouterDiagnostics(sink, log);
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toEqual({ available: false });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the production router log path by default", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-path-"));
    try {
      vi.spyOn(os, "homedir").mockReturnValue(directory);
      const log = resolveModelRouterLogPath(directory);
      await fs.mkdir(path.dirname(log), { recursive: true });
      await fs.writeFile(log, '"POST /v1/chat/completions HTTP/1.1" 200 OK');
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      await retainRouterDiagnostics(sink);
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toMatchObject({ available: true, completionResponses: 1 });
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("captures the onboard child's log when the parent gateway port is filtered out", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-child-path-"));
    try {
      vi.spyOn(os, "homedir").mockReturnValue(directory);
      const onboardEnv = buildProviderRoutedEnv("nvapi-test-key", "e2e-router", {
        NEMOCLAW_GATEWAY_PORT: "9123",
      });
      expect(onboardEnv.NEMOCLAW_GATEWAY_PORT).toBeUndefined();
      const childLog = resolveModelRouterLogPath(directory, DEFAULT_GATEWAY_PORT);
      const parentLog = resolveModelRouterLogPath(directory, 9123);
      await fs.mkdir(path.dirname(childLog), { recursive: true });
      await fs.mkdir(path.dirname(parentLog), { recursive: true });
      await fs.writeFile(childLog, '"POST /v1/chat/completions HTTP/1.1" 200 OK');
      await fs.writeFile(parentLog, "AuthenticationError");
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      const cleanup = new CleanupRegistry();
      registerRouterDiagnostics(cleanup, sink, onboardEnv);
      expect(await cleanup.runAll()).toEqual({
        passed: ["retain Model Router diagnostics"],
        failures: [],
      });
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toMatchObject({
        available: true,
        completionResponses: 1,
        authenticationErrorReported: false,
      });
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
