// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const PROXY_DIST = require.resolve("./proxy");
const LOCAL_DIST = require.resolve("../local");
const CREDS_DIST = require.resolve("../../credentials/store");
const CHILD_PROCESS_DIST = require.resolve("node:child_process");
const RUNNER_DIST = require.resolve("../../runner");

interface MockSetup {
  installed: string[] | (() => string[]);
  promptValues: string[];
  pullStatus?: number;
}

function loadProxyWithMocks(setup: MockSetup): {
  proxy: typeof import("./proxy");
  promptArgs: string[];
  runCalls: Array<{ command: readonly string[]; options: unknown }>;
  validateCalls: unknown[][];
  warmupModels: string[];
  restore: () => void;
} {
  const local = require(LOCAL_DIST);
  const creds = require(CREDS_DIST);
  const childProcess = require(CHILD_PROCESS_DIST) as typeof import("node:child_process");
  const runner = require(RUNNER_DIST);
  const originalGetOllamaModelOptions = local.getOllamaModelOptions;
  const originalGetOllamaWarmupCommand = local.getOllamaWarmupCommand;
  const originalPrompt = creds.prompt;
  const originalProbeOllamaModelCapabilities = local.probeOllamaModelCapabilities;
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;
  const originalValidateOllamaModel = local.validateOllamaModel;
  const spawnSync =
    setup.pullStatus === undefined
      ? null
      : vi.spyOn(childProcess, "spawnSync").mockReturnValue({
          status: setup.pullStatus,
          signal: null,
          output: [],
          pid: 1,
          stdout: "",
          stderr: "",
        });
  const promptArgs: string[] = [];
  const runCalls: Array<{ command: readonly string[]; options: unknown }> = [];
  const validateCalls: unknown[][] = [];
  const warmupModels: string[] = [];
  let promptCallIndex = 0;

  local.getOllamaModelOptions = () =>
    typeof setup.installed === "function" ? setup.installed() : setup.installed;
  creds.prompt = async (message: string) => {
    promptArgs.push(message);
    const value = setup.promptValues[promptCallIndex];
    promptCallIndex += 1;
    return value ?? "";
  };
  local.probeOllamaModelCapabilities = () => ({
    source: "api",
    capabilities: ["tools"],
    supportsTools: true,
  });
  local.getOllamaWarmupCommand = (model: string) => {
    warmupModels.push(model);
    return ["warmup", model];
  };
  local.validateOllamaModel = (...args: unknown[]) => {
    validateCalls.push(args);
    return { ok: true };
  };
  runner.run = (command: readonly string[], options: unknown) => {
    runCalls.push({ command, options });
    return { status: 0 };
  };
  // pullOllamaModel asks whether a local `ollama` binary exists before choosing
  // the CLI or the HTTP pull path (#7472). These cases exercise the CLI path.
  runner.runCapture = () => "/usr/bin/ollama";

  delete require.cache[PROXY_DIST];
  const proxy = require(PROXY_DIST);
  return {
    proxy,
    promptArgs,
    runCalls,
    validateCalls,
    warmupModels,
    restore() {
      delete require.cache[PROXY_DIST];
      local.getOllamaModelOptions = originalGetOllamaModelOptions;
      local.getOllamaWarmupCommand = originalGetOllamaWarmupCommand;
      creds.prompt = originalPrompt;
      local.probeOllamaModelCapabilities = originalProbeOllamaModelCapabilities;
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
      local.validateOllamaModel = originalValidateOllamaModel;
      spawnSync?.mockRestore();
    },
  };
}

describe("promptOllamaModel installed-model fit filter", () => {
  let active: { restore: () => void } | null = null;
  afterEach(() => {
    active?.restore();
    active = null;
  });

  it("downgrades to a starter model when the only installed entry exceeds available memory", async () => {
    const setup = loadProxyWithMocks({
      installed: ["qwen3.6:35b"],
      // Enter on the rendered default.
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    expect(result).toBe("qwen3.5:9b");
  });

  it("keeps a fitting installed model as the default", async () => {
    const installed = vi.fn(() => ["qwen3.5:9b", "qwen3.6:35b"]);
    const setup = loadProxyWithMocks({
      installed,
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    // Only qwen3.5:9b fits; the menu offers only it, Enter selects it.
    expect(result).toBe("qwen3.5:9b");
    expect(installed).toHaveBeenCalledTimes(1);
  });

  it("defaults to a requested model when it is shown in the installed model menu", async () => {
    const setup = loadProxyWithMocks({
      installed: ["qwen2.5:0.5b", "qwen3.6:35b"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { defaultModel: "qwen3.6:35b" },
    );
    expect(result).toBe("qwen3.6:35b");
    expect(setup.promptArgs).toEqual(["  Choose model [2]: "]);
  });

  it("prefers the largest registered fitting model over an unregistered tag when the requested default is not shown (#10103)", async () => {
    const setup = loadProxyWithMocks({
      installed: ["qwen2.5:0.5b", "qwen3.5:9b"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { defaultModel: "qwen3.6:35b" },
    );
    // qwen2.5:0.5b is not in the registry, so it cannot outrank the known,
    // larger qwen3.5:9b — the menu still lists both in installed order, but
    // the default selection is the registered model, not whichever listed
    // first.
    expect(result).toBe("qwen3.5:9b");
    expect(setup.promptArgs).toEqual(["  Choose model [2]: "]);
  });

  it("respects unknown installed tags (not in the registry) even when nothing else fits", async () => {
    const setup = loadProxyWithMocks({
      installed: ["my-custom:model"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    expect(result).toBe("my-custom:model");
  });

  it("drops excludeModels entries from the installed-fitting menu so a repeat probe-fail does not loop", async () => {
    // Caller (selectAndValidateOllamaModel) records `nemotron-3-nano:30b` as a
    // probe-fail and excludes it. Without this filter, pressing Enter on the
    // installed-fitting list would re-select the broken model and dead-loop.
    const setup = loadProxyWithMocks({
      installed: ["nemotron-3-nano:30b", "qwen3.5:9b"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { excludeModels: new Set(["nemotron-3-nano:30b"]) },
    );
    expect(result).toBe("qwen3.5:9b");
  });

  it("falls back to bootstrap options and never re-offers excluded entries", async () => {
    const setup = loadProxyWithMocks({
      installed: ["nemotron-3-nano:30b"],
      // Pick the first menu entry explicitly. With nemotron-3-nano:30b
      // excluded, the bootstrap fall-back menu lists [qwen3.5:9b, qwen3.6:35b]
      // smallest-first; option 1 must resolve to qwen3.5:9b, never the
      // excluded tag.
      promptValues: ["1"],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { excludeModels: new Set(["nemotron-3-nano:30b"]) },
    );
    expect(result).toBe("qwen3.5:9b");
    expect(result).not.toBe("nemotron-3-nano:30b");
  });
});

describe("promptOllamaModel size and memory annotations", () => {
  let active: { restore: () => void } | null = null;
  let logSpy: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(() => {
    logSpy?.mockRestore();
    logSpy = null;
    active?.restore();
    active = null;
  });

  it("annotates each model with download size and required VRAM and shows available memory", async () => {
    const setup = loadProxyWithMocks({ installed: ["qwen3.5:9b"], promptValues: [""] });
    active = setup;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    const menu = logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("\n");
    expect(result).toBe("qwen3.5:9b");
    expect(menu).toContain("Available GPU memory: 128.00 GB");
    expect(menu).toContain("6.15 GB download");
    expect(menu).toContain("~11.72 GB VRAM");
  });

  it("labels total memory separately when available memory is unknown", async () => {
    const setup = loadProxyWithMocks({ installed: ["qwen3.5:9b"], promptValues: [""] });
    active = setup;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 8_000,
    });
    const menu = logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("\n");
    expect(result).toBe("qwen3.5:9b");
    expect(menu).toContain("Total GPU memory: 7.81 GB");
    expect(menu).toContain("exceeds total memory");
    expect(menu).toContain("fits the host's total GPU memory");
    expect(menu).toContain("may not fit total GPU memory; choose a smaller model");
    expect(menu).not.toContain("Available GPU memory");
    expect(menu).not.toContain("exceeds available memory");
    expect(menu).not.toContain("currently available");
  });

  it("renders name-only for an installed tag the registry does not know", async () => {
    const setup = loadProxyWithMocks({ installed: ["my-custom:model"], promptValues: [""] });
    active = setup;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 131_072,
    });
    const menu = logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("\n");
    expect(result).toBe("my-custom:model");
    expect(menu).toContain("1) my-custom:model");
    expect(menu).not.toContain("my-custom:model  (");
  });
});

describe("prepareOllamaModel post-pull discovery", () => {
  let active: { restore: () => void } | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    active?.restore();
    active = null;
  });

  it("warms and validates after a pulled model appears in discovery (#6038)", async () => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    const setup = loadProxyWithMocks({
      installed: [],
      promptValues: [],
      pullStatus: 0,
    });
    active = setup;
    let attempts = 0;
    let nowMs = 0;
    const sleeps: number[] = [];

    const result = await setup.proxy.prepareOllamaModel("qwen3.5:9b", [], undefined, {
      getModelOptions: () => {
        attempts += 1;
        return attempts >= 2 ? ["qwen3.5:9b"] : [];
      },
      now: () => nowMs,
      sleep: (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(result).toEqual({ ok: true, allowToolsIncompatible: false });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(setup.warmupModels).toEqual(["qwen3.5:9b"]);
    expect(setup.runCalls).toEqual([
      { command: ["warmup", "qwen3.5:9b"], options: { ignoreError: true } },
    ]);
    expect(setup.validateCalls).toEqual([
      ["qwen3.5:9b", undefined, undefined, undefined, { allowToolsIncompatible: false }],
    ]);
  });

  it("rejects a zero-exit pull that never appears in discovery (#6038)", async () => {
    const setup = loadProxyWithMocks({ installed: [], promptValues: [], pullStatus: 0 });
    active = setup;

    let attempts = 0;
    let nowMs = 0;
    const sleeps: number[] = [];
    const result = await setup.proxy.prepareOllamaModel("qwen3.5:9b", [], undefined, {
      getModelOptions: () => {
        attempts += 1;
        return [];
      },
      now: () => nowMs,
      sleep: (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(result).toEqual({
      ok: false,
      message:
        "Ollama pull for 'qwen3.5:9b' completed, but Ollama did not list the model afterward. " +
        "Wait for Ollama to finish registering the model, then choose it again.",
    });
    expect(attempts).toBe(8);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000]);
  });
});

describe("pullOllamaModel CLI-vs-HTTP dispatch", () => {
  function loadProxyForDispatch(setup: {
    host: string;
    hasLocalCli: boolean;
    httpCloseCode?: number;
  }) {
    const local = require(LOCAL_DIST);
    const runner = require(RUNNER_DIST);
    const childProcess = require(CHILD_PROCESS_DIST) as typeof import("node:child_process");
    const originalRunCapture = runner.runCapture;
    const cliCommands: string[][] = [];
    const httpCommands: string[][] = [];

    runner.runCapture = () => (setup.hasLocalCli ? "/usr/bin/ollama" : "");

    const spawnSync = vi
      .spyOn(childProcess, "spawnSync")
      .mockImplementation((file: unknown, args: unknown) => {
        cliCommands.push([String(file), ...(((args as string[]) ?? []) as string[]).map(String)]);
        return { status: 0, signal: null, output: [], pid: 1, stdout: "", stderr: "" } as never;
      });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((file: unknown, args) => {
      httpCommands.push([String(file), ...(((args as string[]) ?? []) as string[]).map(String)]);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        const closeCode = setup.httpCloseCode ?? 0;
        const output = closeCode === 0 ? '{"status":"success"}\n' : "";
        child.stdout.end(output, () => {
          setImmediate(() => child.emit("close", closeCode));
        });
      });
      return child as never;
    });

    local.setResolvedOllamaHost(setup.host);
    delete require.cache[PROXY_DIST];
    const proxy = require(PROXY_DIST) as typeof import("./proxy");
    return {
      proxy,
      cliCommands,
      httpCommands,
      restore() {
        delete require.cache[PROXY_DIST];
        runner.runCapture = originalRunCapture;
        spawnSync.mockRestore();
        spawn.mockRestore();
        local.setResolvedOllamaHost(null);
      },
    };
  }

  let active: ReturnType<typeof loadProxyForDispatch> | null = null;

  afterEach(() => {
    active?.restore();
    active = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pulls over HTTP when the daemon resolves on the Windows host", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    active = loadProxyForDispatch({ host: "host.docker.internal", hasLocalCli: true });

    await active.proxy.pullOllamaModel("qwen3.5:9b");

    expect(active.httpCommands.map((command) => command[0])).toContain("curl");
    expect(active.cliCommands.map((command) => command[0])).not.toContain("bash");
  });

  it("pulls over HTTP when a loopback daemon has no local ollama binary (#7472)", async () => {
    // WSL mirrored networking: the Windows daemon answers on 127.0.0.1, so the
    // resolved host reads local while WSL still has no `ollama` to shell out to.
    vi.spyOn(console, "log").mockImplementation(() => {});
    active = loadProxyForDispatch({ host: "127.0.0.1", hasLocalCli: false });

    await active.proxy.pullOllamaModel("qwen3.5:9b");

    expect(active.httpCommands.map((command) => command[0])).toContain("curl");
    expect(active.cliCommands.map((command) => command[0])).not.toContain("bash");
  });

  it("keeps the CLI pull when a local ollama binary is installed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    active = loadProxyForDispatch({ host: "127.0.0.1", hasLocalCli: true });

    await active.proxy.pullOllamaModel("qwen3.5:9b");

    expect(active.cliCommands.map((command) => command[0])).toContain("bash");
    expect(active.httpCommands.map((command) => command[0])).not.toContain("curl");
  });

  it("reports a Windows-host connection timeout instead of the configured pull limit (#10259)", async () => {
    vi.stubEnv("NEMOCLAW_OLLAMA_PULL_TIMEOUT", "1800");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    active = loadProxyForDispatch({
      host: "host.docker.internal",
      hasLocalCli: false,
      httpCloseCode: 28,
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(11_200);

    const result = await active.proxy.pullOllamaModel("qwen3.5:9b");

    const errors = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(result).toBe(false);
    expect(errors).toContain("Model pull connection timed out after 10 seconds.");
    expect(errors).toContain("The wall-clock limit of 30 minutes was not reached.");
    expect(errors).not.toContain("Model pull timed out after 30 minutes.");
  });

  it("reports the configured wall-clock limit when the HTTP pull reaches it (#10259)", async () => {
    vi.stubEnv("NEMOCLAW_OLLAMA_PULL_TIMEOUT", "1800");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    active = loadProxyForDispatch({
      host: "host.docker.internal",
      hasLocalCli: false,
      httpCloseCode: 28,
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_801_000);

    const result = await active.proxy.pullOllamaModel("qwen3.5:9b");

    const errors = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(result).toBe(false);
    expect(errors).toContain("Model pull timed out after 30 minutes.");
    expect(errors).not.toContain("Model pull connection timed out");
  });
});
