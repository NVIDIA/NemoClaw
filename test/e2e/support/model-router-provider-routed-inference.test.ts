// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { catalogueTargetsForChangedFiles } from "../../../tools/e2e/target-catalogue.mts";
import { resolveModelRouterLogPath } from "../../../src/lib/onboard/model-router.ts";
import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";

import { HostCliClient, type CommandRunner } from "../fixtures/clients/index.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import {
  buildProviderRoutedEnv,
  modelRouterAgentCommand,
  retainRouterDiagnostics,
  registerRouterDiagnostics,
  routerSelectionsSince,
} from "../live/model-router-provider-routed-inference-helpers.ts";

// Model a test process configured for a different gateway than its filtered child.
vi.mock("../../../src/lib/core/ports.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/core/ports.ts")>()),
  GATEWAY_PORT: 9123,
}));

describe("Model Router provider-routed live support", () => {
  it.each([
    "nemoclaw-blueprint/router/pool-config.yaml",
    "nemoclaw-blueprint/router/rules.py",
    "nemoclaw-blueprint/router/model-router",
    "src/lib/onboard/model-router-command.ts",
    "scripts/generate-openclaw-config.mts",
    "src/lib/onboard/inference-input-capability.ts",
    "src/lib/actions/sandbox/destroy-preflight.ts",
    "src/lib/onboard/model-router-process.ts",
    "src/lib/onboard/model-router.ts",
    "test/e2e/live/model-router-provider-routed-inference-helpers.ts",
  ])("selects the Model Router target when %s changes", (changedFile) => {
    expect(catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id)).toContain(
      "model-router-provider-routed-inference",
    );
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

it("retains only supported router selections from the current interval (#14066)", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-selection-"));
  try {
    const log = path.join(directory, "router.log");
    const old = "Model Router selected=nvidia/nemotron-3.5-lightning-30b-a3b rule=text\n";
    await fs.writeFile(
      log,
      old +
        "private prompt; Authorization: secret\nModel Router selected=nvidia/nemotron-3.5-super-vl-120b-a12b rule=image\n",
    );
    expect(routerSelectionsSince(log, Buffer.byteLength(old))).toEqual([
      { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", rule: "image" },
    ]);
    await fs.writeFile(log, "x".repeat(65537));
    expect(() => routerSelectionsSince(log, 0)).toThrow("unavailable");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("Model Router native agent admission", () => {
  async function runAgentProgram(
    params: Record<string, unknown>,
    overrides: Record<string, string> = {},
    resolution: "absolute" | "unset" | "bare" | "missing" = "absolute",
  ) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-agent-"));
    try {
      const runtime = path.join(directory, "node_modules/openclaw");
      await fs.mkdir(runtime, { recursive: true });
      await fs.writeFile(
        path.join(runtime, "package.json"),
        JSON.stringify({ exports: { "./plugin-sdk/gateway-runtime": "./gateway-runtime.mjs" } }),
      );
      await fs.writeFile(
        path.join(runtime, "gateway-runtime.mjs"),
        `export async function callGatewayFromCli(method, options, params, caller) {
          if (process.env.REJECT_AGENT === "1") throw new Error("Agent admission denied.");
          const { token, ...connection } = options;
          return { method, connection, authenticated: Boolean(token), params, caller };
        }`,
      );
      const binary = path.join(runtime, "openclaw.mjs");
      await fs.writeFile(binary, "", { mode: 0o700 });
      await fs.symlink(binary, path.join(runtime, "openclaw"));
      const bashEnv = path.join(directory, "bash-env.sh");
      await fs.writeFile(
        bashEnv,
        `export PATH="$FIXTURE_OPENCLAW_PATH:$PATH"
openclaw() { printf 'The runtime guard must not be invoked.\n' >&2; return 97; }
`,
      );
      const command = modelRouterAgentCommand(params);
      return spawnSync(command[0]!, command.slice(1), {
        encoding: "utf8",
        env: {
          HOME: directory,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          BASH_ENV: bashEnv,
          FIXTURE_OPENCLAW_PATH: runtime,
          OPENCLAW_BIN:
            resolution === "unset"
              ? undefined
              : resolution === "bare"
                ? "openclaw"
                : resolution === "missing"
                  ? path.join(directory, "missing-openclaw")
                  : binary,
          OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
          ...overrides,
        },
        timeout: 10_000,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  it.each([
    { model: "nvidia-routed", message: "Reply with a greeting." },
    { model: "nvidia/nemotron-3.5-super-vl-120b-a12b", message: "Reply with a greeting." },
    {
      model: "nvidia-routed",
      attachments: [{ mimeType: "image/png", content: "synthetic-image" }],
    },
  ])("forwards the native agent turn through authenticated backend admission: %j", async (turn) => {
    const params = { agentId: "main", provider: "inference", ...turn };
    const result = await runAgentProgram(params);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      method: "agent",
      authenticated: true,
      connection: {
        url: "ws://127.0.0.1:18789/",
        timeout: "180000",
        expectFinal: true,
        json: true,
      },
      params,
      caller: {
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.admin"],
        progress: false,
      },
    });
    expect(result.stdout + result.stderr).not.toContain("synthetic-gateway-token");
  });

  it.each(["unset", "bare"] as const)(
    "loads the native SDK when the runtime guard shadows the %s executable setting",
    async (resolution) => {
      const params = { agentId: "main", model: "nvidia-routed", provider: "inference" };
      const result = await runAgentProgram(params, {}, resolution);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        method: "agent",
        authenticated: true,
        params,
      });
      expect(result.stdout + result.stderr).not.toContain("synthetic-gateway-token");
    },
  );

  it("rejects a missing executable before gateway admission", async () => {
    const result = await runAgentProgram({}, { REJECT_AGENT: "1" }, "missing");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("Agent admission denied.");
    expect(result.stdout + result.stderr).not.toContain("synthetic-gateway-token");
  });

  it("rejects a missing gateway credential before loading the SDK", async () => {
    const result = await runAgentProgram({}, { OPENCLAW_GATEWAY_TOKEN: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The OpenClaw gateway token is required.");
  });

  it.each(["65536", "not-a-port", "ws://untrusted.example"])(
    "rejects an invalid gateway port %j",
    async (port) => {
      const result = await runAgentProgram({}, { OPENCLAW_GATEWAY_PORT: port });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid URL");
    },
  );

  it("propagates gateway admission failure", async () => {
    const result = await runAgentProgram({}, { REJECT_AGENT: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Agent admission denied.");
    expect(result.stdout).toBe("");
  });
});
