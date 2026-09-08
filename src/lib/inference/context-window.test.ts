// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// Most tests inject deps, so these mocks replace the real inference stack under
// vitest. The default-deps suite below calls through to them.
vi.mock("./local", () => ({
  createOllamaApiCaptureEx: vi.fn((capture) => capture),
  getOllamaProbeCommand: vi.fn(() => ["curl", "ollama-probe"]),
  resolveOllamaRuntimeContextWindow: vi.fn(() => null),
}));
vi.mock("./vllm-runtime-context", () => ({ resolveVllmContextWindowFromModels: vi.fn() }));

import {
  createOllamaApiCaptureEx,
  getOllamaProbeCommand,
  resolveOllamaRuntimeContextWindow,
} from "./local";
import { type ContextWindowDeps, resolveContextWindowForModel } from "./context-window";

// The default dependencies reach ../runner through a lazy CJS require, so swap the
// export on the loaded module instead of mocking the specifier.
type CaptureStub = { stdout: string; exitCode: number | null; timedOut: boolean };

const runner = require("../runner") as {
  runCaptureEx: (cmd: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => CaptureStub;
};

function captured(timedOut = false): CaptureStub {
  return { stdout: "", exitCode: 0, timedOut };
}

function makeDeps(over: Partial<ContextWindowDeps> = {}): ContextWindowDeps {
  return {
    loadOllamaModel: vi.fn(),
    probeOllamaContextWindow: vi.fn(() => 16384),
    probeVllmContextWindow: vi.fn(() => 262144),
    defaultCloudContextWindow: vi.fn(() => 131072),
    ...over,
  };
}

describe("resolveContextWindowForModel", () => {
  it("ollama-local: loads the model, then returns the probed window", () => {
    const deps = makeDeps({ probeOllamaContextWindow: vi.fn(() => 16384) });

    expect(resolveContextWindowForModel("ollama-local", "qwen2.5:7b", deps)).toBe(16384);
    expect(deps.loadOllamaModel).toHaveBeenCalledWith("qwen2.5:7b");
    expect(deps.defaultCloudContextWindow).not.toHaveBeenCalled();
  });

  it("ollama-local: finishes loading the model before probing it (#8974)", () => {
    const order: string[] = [];
    const deps = makeDeps({
      loadOllamaModel: vi.fn(() => {
        order.push("load");
      }),
      probeOllamaContextWindow: vi.fn(() => {
        order.push("probe");
        return 16384;
      }),
    });

    resolveContextWindowForModel("ollama-local", "qwen2.5:7b", deps);

    expect(order).toEqual(["load", "probe"]);
  });

  it("ollama-local: returns null when the probe cannot read a window", () => {
    const deps = makeDeps({ probeOllamaContextWindow: vi.fn(() => null) });

    expect(resolveContextWindowForModel("ollama-local", "qwen2.5:7b", deps)).toBeNull();
    expect(deps.loadOllamaModel).toHaveBeenCalledTimes(1);
  });

  it("vllm-local: returns the probed max_model_len without loading", () => {
    const deps = makeDeps({ probeVllmContextWindow: vi.fn(() => 262144) });

    expect(resolveContextWindowForModel("vllm-local", "some-model", deps)).toBe(262144);
    expect(deps.probeVllmContextWindow).toHaveBeenCalledWith("some-model");
    expect(deps.loadOllamaModel).not.toHaveBeenCalled();
    expect(deps.probeOllamaContextWindow).not.toHaveBeenCalled();
  });

  it("vllm-local: returns null when the server is unreachable", () => {
    const deps = makeDeps({ probeVllmContextWindow: vi.fn(() => null) });

    expect(resolveContextWindowForModel("vllm-local", "some-model", deps)).toBeNull();
    expect(deps.loadOllamaModel).not.toHaveBeenCalled();
  });

  it("cloud provider: returns the default window without loading or probing", () => {
    const deps = makeDeps({ defaultCloudContextWindow: vi.fn(() => 131072) });

    expect(
      resolveContextWindowForModel("nvidia-prod", "nvidia/nemotron-3-super-120b-a12b", deps),
    ).toBe(131072);
    expect(deps.loadOllamaModel).not.toHaveBeenCalled();
    expect(deps.probeOllamaContextWindow).not.toHaveBeenCalled();
  });
});

describe("resolveContextWindowForModel default dependencies (#8974)", () => {
  const originalRunCaptureEx = runner.runCaptureEx;

  afterEach(() => {
    runner.runCaptureEx = originalRunCaptureEx;
    vi.mocked(createOllamaApiCaptureEx).mockImplementation((capture) => capture!);
  });

  it("ollama-local: runs the blocking probe command, not a backgrounded warm-up", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const commands: string[][] = [];
    runner.runCaptureEx = (cmd) => {
      commands.push([...cmd]);
      return captured();
    };
    vi.mocked(getOllamaProbeCommand).mockReturnValue(["curl", "ollama-probe"]);
    vi.mocked(resolveOllamaRuntimeContextWindow).mockReturnValue(16384);

    expect(resolveContextWindowForModel("ollama-local", "qwen3.5:9b")).toBe(16384);
    expect(getOllamaProbeCommand).toHaveBeenCalledWith("qwen3.5:9b");
    expect(commands).toEqual([["curl", "ollama-probe"]]);
    expect(logSpy).toHaveBeenCalledWith("  Priming Ollama model: qwen3.5:9b");
  });

  it("ollama-local: retries the load at 300 s when the first probe times out", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let attempts = 0;
    runner.runCaptureEx = () => {
      attempts += 1;
      return captured(attempts === 1);
    };
    vi.mocked(getOllamaProbeCommand).mockReturnValue(["curl", "ollama-probe"]);
    vi.mocked(resolveOllamaRuntimeContextWindow).mockReturnValue(16384);

    expect(resolveContextWindowForModel("ollama-local", "qwen3.5:9b")).toBe(16384);
    expect(attempts).toBe(2);
    expect(getOllamaProbeCommand).toHaveBeenLastCalledWith("qwen3.5:9b", 300);
  });

  it("ollama-local: isolates Docker credentials for the initial and retry probes", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cleanup = vi.fn();
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    let attempts = 0;
    runner.runCaptureEx = (_command, options) => {
      environments.push(options?.env);
      attempts += 1;
      return captured(attempts === 1);
    };
    vi.mocked(createOllamaApiCaptureEx).mockImplementation((capture) => (command, options) => {
      try {
        return capture!(command, {
          ...options,
          env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
        });
      } finally {
        cleanup();
      }
    });
    vi.mocked(getOllamaProbeCommand).mockReturnValue(["docker", "run", "ollama-probe"]);
    vi.mocked(resolveOllamaRuntimeContextWindow).mockReturnValue(16384);

    expect(resolveContextWindowForModel("ollama-local", "qwen3.5:9b")).toBe(16384);
    expect(environments).toEqual([
      { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      { DOCKER_CONFIG: "/tmp/credential-free-docker" },
    ]);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("ollama-local: does not retry when the first probe fails without timing out", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let attempts = 0;
    runner.runCaptureEx = () => {
      attempts += 1;
      return captured();
    };
    vi.mocked(getOllamaProbeCommand).mockReturnValue(["curl", "ollama-probe"]);
    vi.mocked(resolveOllamaRuntimeContextWindow).mockReturnValue(null);

    expect(resolveContextWindowForModel("ollama-local", "qwen3.5:9b")).toBeNull();
    expect(attempts).toBe(1);
  });

  it("ollama-local: reads the runtime window only after the model load returns", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order: string[] = [];
    runner.runCaptureEx = () => {
      order.push("load");
      return captured();
    };
    vi.mocked(getOllamaProbeCommand).mockReturnValue(["curl", "ollama-probe"]);
    vi.mocked(resolveOllamaRuntimeContextWindow).mockImplementation(() => {
      order.push("probe");
      return 16384;
    });

    expect(resolveContextWindowForModel("ollama-local", "qwen3.5:9b")).toBe(16384);
    expect(order).toEqual(["load", "probe"]);
  });
});
