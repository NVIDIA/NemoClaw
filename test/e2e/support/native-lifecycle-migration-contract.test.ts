// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restorationScript } from "../live/openclaw-restoration.ts";
import * as fakeInference from "../fixtures/fake-openai-compatible.ts";

const captured = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: captured.test,
}));

async function runCronTarget(
  endpoint: string,
  runResult = { exitCode: 0, stdout: '{"ok":true,"ran":true}', stderr: "" },
) {
  vi.stubEnv("NEMOCLAW_ENDPOINT_URL", endpoint);
  vi.stubEnv("NEMOCLAW_SANDBOX_NAME", "cron-test");
  vi.spyOn(Date, "now").mockReturnValue(42);
  vi.resetModules();
  captured.test.mockClear();
  await import("../live/cron-preflight-inference-local.test.ts");
  const run = captured.test.mock.calls[0]![2] as (fixtures: object) => Promise<void>;
  const success = { exitCode: 0, stdout: "", stderr: "" };
  const exec = vi
    .fn()
    .mockResolvedValueOnce(success)
    .mockResolvedValueOnce({
      ...success,
      stdout: '{"name":"nemoclaw-native-cron-42","id":"cron-42"}',
    })
    .mockResolvedValueOnce(runResult)
    .mockResolvedValueOnce(success);
  const command = vi.fn(
    async (_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => success,
  );
  const complete = vi.fn();
  const cleanupSandbox = vi.fn(async () => success);
  const trackDisposable = vi.fn();
  const finished = run({
    artifacts: { target: { declare: vi.fn(), complete } },
    cleanup: { trackDisposable },
    host: { command },
    progress: { phase: vi.fn() },
    runtimeProvider: { requireAvailable: vi.fn() },
    sandbox: {
      exec,
      cleanupSandbox,
      openshell: vi.fn(async () => ({
        ...success,
        stdout: JSON.stringify({
          paired: [{ scopes: ["operator.admin"], tokens: [{ scopes: ["operator.admin"] }] }],
        }),
      })),
    },
    secrets: { required: () => "test-hosted-key" },
  });
  return { finished, exec, command, complete, cleanupSandbox, trackDisposable };
}

describe("native scheduled inference target", () => {
  it.each(["https://inference-api.nvidia.com/v1", "https://selected.example/team/v1"])(
    "reports the selected %s endpoint after running and removing scheduled work",
    async (endpoint) => {
      const fixture = await runCronTarget(endpoint);
      await fixture.finished;
      expect(fixture.command.mock.calls[0]![2].env).toMatchObject({
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_ENDPOINT_URL: endpoint,
        COMPATIBLE_API_KEY: "test-hosted-key",
      });
      expect(fixture.exec.mock.calls.map((call) => call[1].slice(0, 3))).toEqual([
        ["openclaw", "cron", "add"],
        ["openclaw", "cron", "add"],
        ["openclaw", "cron", "run"],
        ["openclaw", "cron", "remove"],
      ]);
      expect(fixture.exec.mock.calls.slice(2).map((call) => call[1][3])).toEqual([
        "cron-42",
        "cron-42",
      ]);
      expect(fixture.complete).toHaveBeenCalledExactlyOnceWith({
        id: "cron-preflight-inference-local",
        status: "passed",
        nativeCronId: "cron-42",
        nativeRunAccepted: true,
        inferenceRoute: endpoint,
      });
      await fixture.trackDisposable.mock.calls[0]![1]();
      expect(fixture.cleanupSandbox).toHaveBeenLastCalledWith(
        "cron-test",
        expect.objectContaining({
          artifactName: "cron-preflight-cleanup-openshell-delete",
        }),
      );
    },
  );

  it.each([
    { exitCode: 42, stdout: "", stderr: "command failed" },
    { exitCode: 0, stdout: '{"ok":true,"ran":false}', stderr: "" },
    { exitCode: 0, stdout: '{"ok":true,"ran":true}', stderr: "EAI_AGAIN" },
  ])("does not report completion for a rejected cron run %j", async (runResult) => {
    const fixture = await runCronTarget("https://selected.example/v1", runResult);
    await expect(fixture.finished).rejects.toThrow();
    expect(fixture.complete).not.toHaveBeenCalled();
    await fixture.trackDisposable.mock.calls[0]![1]();
    expect(fixture.cleanupSandbox).toHaveBeenCalledTimes(2);
  });
});

const LIVE_ROOT = path.join(import.meta.dirname, "..", "live");

function liveSource(name: string): string {
  return fs.readFileSync(path.join(LIVE_ROOT, name), "utf8");
}

describe("native lifecycle E2E migration contracts", () => {
  it.each([
    [
      "rebuild-openclaw.test.ts",
      /const DASHBOARD_PORT = 18_792[\s\S]*\$\{String\(DASHBOARD_PORT\)\}\/health/u,
      "/sandbox/.openclaw/workspace",
    ],
    ["rebuild-hermes.test.ts", /127\.0\.0\.1:8642\/health/u, "/sandbox/.hermes/memories"],
  ])("reduces %s to state restoration and native readiness", (file, readiness, statePath) => {
    const source = liveSource(file);

    expect(source).toContain('"rebuild", "--yes", "--verbose"');
    expect(source).toContain(statePath);
    expect(source).toMatch(readiness);
    expect(source).toContain("sandbox.cleanupSandbox");
    expect(source).not.toMatch(/Dockerfile\.base|repair controller|respawn|quarantine/iu);
  });
});

const RESTORED_MARKERS = [
  ".openclaw/workspace/.rebuild-state-marker",
  ".rebuild-unknown-marker",
  ".openclaw/hooks/.rebuild-hook-marker",
  ".openclaw/cron/.rebuild-cron-marker",
  ".local/share/e2e-package/.rebuild-package-marker",
];
const LOADED_PLUGIN = JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "loaded" } });

describe("OpenClaw rebuild restoration verification", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild restoration'-"));
    for (const marker of RESTORED_MARKERS) {
      const filename = path.join(directory, marker);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "expected-marker\n");
    }
    fs.writeFileSync(
      path.join(directory, "openclaw"),
      `#!/bin/sh
if [ "$#" -eq 4 ] && [ "$*" = "config get agents.defaults.timeoutSeconds --json" ]; then
  printf '119\\n'
  exit "$CONFIG_EXIT"
fi
if [ "$#" -eq 5 ] && [ "$*" = "plugins inspect e2e-rebuild-plugin --runtime --json" ]; then
  printf '%s\\n' "$PLUGIN_JSON"
  exit "$PLUGIN_EXIT"
fi
exit 2
`,
      { mode: 0o700 },
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function restorationCommand(): string {
    return restorationScript({
      home: directory,
      openclaw: path.join(directory, "openclaw"),
      node: process.execPath,
    });
  }

  function runRestoration(overrides: Record<string, string> = {}, script = restorationCommand()) {
    const result = spawnSync("/bin/sh", ["-lc", script], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        CONFIG_EXIT: "0",
        PLUGIN_EXIT: "0",
        PLUGIN_JSON: LOADED_PLUGIN,
        ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout };
  }

  it("accepts restored state and a loaded plugin", () => {
    expect(runRestoration()).toEqual({ status: 0, stdout: "expected-marker\n119\n" });
  });

  it.each([
    [
      "wrong plugin ID",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect other --runtime --json",
    ],
    [
      "missing runtime inspection",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect e2e-rebuild-plugin --json",
    ],
    [
      "extra plugin argument",
      "plugins inspect e2e-rebuild-plugin --runtime --json",
      "plugins inspect e2e-rebuild-plugin --runtime --json extra",
    ],
    [
      "wrong config key",
      "config get agents.defaults.timeoutSeconds --json",
      "config get other --json",
    ],
    [
      "missing config JSON flag",
      "config get agents.defaults.timeoutSeconds --json",
      "config get agents.defaults.timeoutSeconds",
    ],
  ])("rejects %s in the restoration command", (_name, command, replacement) => {
    const script = restorationCommand().replace(command, replacement);
    expect(runRestoration({}, script)).toEqual({ status: 2, stdout: "" });
  });

  it.each(RESTORED_MARKERS)("rejects a missing %s", (marker) => {
    fs.rmSync(path.join(directory, marker));
    expect(runRestoration()).toEqual({ status: 1, stdout: "" });
  });

  describe("empty restored markers", () => {
    beforeEach(() => {
      for (const marker of RESTORED_MARKERS) {
        fs.writeFileSync(path.join(directory, marker), "");
      }
    });

    it("accepts matching empty markers", () => {
      expect(runRestoration()).toEqual({ status: 0, stdout: "\n119\n" });
    });

    it("rejects an unreadable target even when the expected marker is empty", () => {
      fs.rmSync(path.join(directory, RESTORED_MARKERS[1]));
      expect(runRestoration()).toEqual({ status: 1, stdout: "" });
    });
  });

  it.each(RESTORED_MARKERS.slice(1))("rejects a mismatched %s", (marker) => {
    fs.writeFileSync(path.join(directory, marker), "wrong");
    expect(runRestoration()).toEqual({ status: 1, stdout: "" });
  });

  it.each(["CONFIG_EXIT", "PLUGIN_EXIT"])("preserves a command failure from %s", (command) => {
    expect(runRestoration({ [command]: "42" })).toEqual({ status: 42, stdout: "" });
  });

  it.each([
    ["error status", JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "error" } })],
    [
      "disabled status",
      JSON.stringify({ plugin: { id: "e2e-rebuild-plugin", status: "disabled" } }),
    ],
    ["wrong ID", JSON.stringify({ plugin: { id: "other", status: "loaded" } })],
    ["missing report", "{}"],
    ["malformed JSON", "{"],
  ])("rejects plugin %s despite command success", (_name, pluginJson) => {
    expect(runRestoration({ PLUGIN_JSON: pluginJson })).toEqual({ status: 1, stdout: "" });
  });
});

describe("GPU double-onboard gateway cleanup", () => {
  it.each([
    {
      stopFails: false,
      cliAvailable: true,
      expected: "install boundary",
      order: ["stop", "remove", "install"],
    },
    { stopFails: true, cliAvailable: true, expected: "owned stop failed", order: ["stop"] },
    {
      stopFails: false,
      cliAvailable: false,
      expected: "install boundary",
      order: ["stop", "install"],
    },
  ])(
    "preserves cleanup order and stop failure (failure=$stopFails)",
    async ({ stopFails, cliAvailable, expected, order }) => {
      vi.stubEnv("NEMOCLAW_SANDBOX_NAME", "e2e-gpu-cleanup");
      vi.stubEnv("NEMOCLAW_CLI_BIN", "fixture-cli");
      vi.resetModules();
      captured.test.mockClear();
      await import("../live/gpu-double-onboard.test.ts");
      const run = captured.test.mock.calls[0]![2] as (fixtures: object) => Promise<void>;
      const observed: string[] = [];
      const success = { exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false };
      const stopGatewayRuntime = vi.fn(async () => {
        observed.push("stop");
        await (stopFails ? Promise.reject(new Error("owned stop failed")) : Promise.resolve());
      });
      const cleanupGatewayRegistration = vi.fn(async () => {
        observed.push("remove");
      });
      const command = vi.fn(
        async (_command: string, _args: string[], options: { artifactName: string }) => {
          const actions: Record<string, () => never> = {
            "phase-1-install-ollama": () => {
              observed.push("install");
              throw new Error("install boundary");
            },
          };
          return actions[options.artifactName]?.() ?? success;
        },
      );
      const openshell = vi.fn(async () => success);
      const trackDisposable = vi.fn((_name: string, _cleanup: () => Promise<void>) => undefined);
      await expect(
        run({
          artifacts: { target: { declare: vi.fn() } },
          cleanup: { trackDisposable, trackSandbox: vi.fn() },
          host: {
            command,
            cleanupGatewayRegistration,
            openshellCommandPath: "openshell",
            isCommandAvailable: vi.fn(async () => cliAvailable),
          },
          lifecycle: { stopGatewayRuntime },
          progress: { phase: vi.fn() },
          runtimeProvider: { requireAvailable: vi.fn() },
          sandbox: { openshell },
          skip: vi.fn(),
        }),
      ).rejects.toThrow(expected);
      expect(observed).toEqual(order);
      expect(stopGatewayRuntime).toHaveBeenCalledExactlyOnceWith({
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw",
          NEMOCLAW_SANDBOX_NAME: "e2e-gpu-cleanup",
        }),
        userServiceMode: "permanent",
      });
      expect(cleanupGatewayRegistration.mock.calls).toHaveLength(
        Number(!stopFails && cliAvailable),
      );
      expect(openshell.mock.calls).toEqual([
        [["sandbox", "delete", "e2e-gpu-cleanup"], expect.any(Object)],
      ]);
      observed.length = 0;
      const terminalCleanup = trackDisposable.mock.calls.find(
        ([name]) => name === "stop GPU gateway runtime before removing its state",
      )![1];
      const outcomes = await Promise.allSettled([terminalCleanup()]);
      expect(outcomes[0]!.status).toBe(stopFails ? "rejected" : "fulfilled");
      expect(observed).toEqual(order.filter((step) => step !== "install"));
    },
  );
});

describe("Messaging token rotation gateway cleanup", () => {
  it.each([
    {
      stopFails: false,
      cliAvailable: true,
      expected: "install boundary",
      order: ["stop", "remove", "install"],
    },
    { stopFails: true, cliAvailable: true, expected: "owned stop failed", order: ["stop"] },
    {
      stopFails: false,
      cliAvailable: false,
      expected: "install boundary",
      order: ["stop", "install"],
    },
  ])(
    "preserves runtime cleanup before registration (failure=$stopFails, CLI=$cliAvailable)",
    async ({ stopFails, cliAvailable, expected, order }) => {
      vi.stubEnv("NEMOCLAW_SANDBOX_NAME", "e2e-token-cleanup");
      vi.resetModules();
      captured.test.mockClear();
      const server = await import("../fixtures/fake-openai-compatible.ts");
      vi.spyOn(server, "startFakeOpenAiCompatibleServer").mockResolvedValue({
        baseUrl: "http://host.openshell.internal:19000/v1",
        logFile: "/fixture/fake-server.log",
        requestsFile: "/fixture/fake-requests.json",
        requests: () => [],
        environmentKeys: () => [],
        close: async () => undefined,
      } satisfies Awaited<ReturnType<typeof fakeInference.startFakeOpenAiCompatibleServer>>);
      await import("../live/token-rotation.test.ts");
      const run = captured.test.mock.calls[0]![2] as (fixtures: object) => Promise<void>;
      const observed: string[] = [];
      const success = { exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false };
      const stopGatewayRuntime = vi.fn(async () => {
        observed.push("stop");
        await (stopFails ? Promise.reject(new Error("owned stop failed")) : Promise.resolve());
      });
      const cleanupGatewayRegistration = vi.fn(async () => {
        observed.push("remove");
      });
      const command = vi.fn(
        async (_command: string, _args: string[], options: { artifactName: string }) => {
          const actions: Record<string, () => never> = {
            "phase-0-install-token-a": () => {
              observed.push("install");
              throw new Error("install boundary");
            },
          };
          return actions[options.artifactName]?.() ?? success;
        },
      );
      const trackGateway = vi.fn(
        (
          _owner: { cleanupGatewayRegistration: () => Promise<void> },
          _name: string,
          _options: object,
        ) => undefined,
      );
      await expect(
        run({
          artifacts: { target: { declare: vi.fn() } },
          cleanup: { trackGateway, trackDisposable: vi.fn(), trackSandbox: vi.fn() },
          host: {
            command,
            cleanupGatewayRegistration,
            openshellCommandPath: "openshell",
            isCommandAvailable: vi.fn(async () => cliAvailable),
          },
          lifecycle: { stopGatewayRuntime },
          progress: { phase: vi.fn() },
          runtimeProvider: { requireAvailable: vi.fn() },
          sandbox: {},
        }),
      ).rejects.toThrow(expected);
      expect(observed).toEqual(order);
      expect(stopGatewayRuntime).toHaveBeenCalledExactlyOnceWith({
        env: expect.any(Object),
        userServiceMode: "permanent",
      });
      expect(cleanupGatewayRegistration.mock.calls).toHaveLength(
        Number(!stopFails && cliAvailable),
      );
      observed.length = 0;
      const terminal = trackGateway.mock.calls[0]![0].cleanupGatewayRegistration;
      const outcomes = await Promise.allSettled([terminal()]);
      expect(outcomes[0]!.status).toBe(stopFails ? "rejected" : "fulfilled");
      expect(observed).toEqual(order.filter((step) => step !== "install"));
    },
  );
});

describe("Hermes fresh runner gateway cleanup", () => {
  it.each([
    {
      stopFails: false,
      cliAvailable: true,
      expected: "prerequisite boundary",
      order: ["stop", "remove", "prerequisite"],
    },
    { stopFails: true, cliAvailable: true, expected: "owned stop failed", order: ["stop"] },
    {
      stopFails: false,
      cliAvailable: false,
      expected: "prerequisite boundary",
      order: ["stop", "prerequisite"],
    },
  ])(
    "preserves owned cleanup before prerequisites ($stopFails/$cliAvailable)",
    async ({ stopFails, cliAvailable, expected, order }) => {
      vi.stubEnv("NEMOCLAW_SANDBOX_NAME", "e2e-hermes-cleanup");
      vi.resetModules();
      captured.test.mockClear();
      await import("../live/hermes-e2e.test.ts");
      const run = captured.test.mock.calls[0]![2] as (fixtures: object) => Promise<void>;
      const observed: string[] = [];
      const success = { exitCode: 0, stdout: "", stderr: "", signal: null, timedOut: false };
      const openshell = vi.fn(async () => success);
      const stopGatewayRuntime = vi.fn(async () => {
        observed.push("stop");
        await (stopFails ? Promise.reject(new Error("owned stop failed")) : Promise.resolve());
      });
      const cleanupGatewayRegistration = vi.fn(async () => {
        observed.push("remove");
      });
      await expect(
        run({
          artifacts: { target: { declare: vi.fn() } },
          cleanup: { trackGateway: vi.fn(), trackDisposable: vi.fn(), trackSandbox: vi.fn() },
          host: {
            command: vi.fn(async () => success),
            openshellCommandPath: "openshell",
            isCommandAvailable: vi.fn(async () => cliAvailable),
            cleanupGatewayRegistration,
          },
          lifecycle: { stopGatewayRuntime, trackInstallerGatewayUserService: vi.fn() },
          inference: { env: () => ({}), redactionValues: () => [], mode: "mock" },
          progress: { phase: vi.fn() },
          runtimeProvider: {
            requireAvailable: vi.fn(async () => {
              observed.push("prerequisite");
              throw new Error("prerequisite boundary");
            }),
          },
          sandbox: { openshell },
        }),
      ).rejects.toThrow(expected);
      expect(observed).toEqual(order);
      expect(openshell).toHaveBeenCalledExactlyOnceWith(
        ["sandbox", "delete", "e2e-hermes-cleanup"],
        expect.any(Object),
      );
      expect(stopGatewayRuntime).toHaveBeenCalledExactlyOnceWith({
        env: expect.objectContaining({
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_SANDBOX_NAME: "e2e-hermes-cleanup",
        }),
        userServiceMode: "permanent",
      });
      expect(cleanupGatewayRegistration.mock.calls).toHaveLength(
        Number(!stopFails && cliAvailable),
      );
    },
  );
});
