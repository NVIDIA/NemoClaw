// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { type AgentPassthroughDeps, runAgentPassthrough } from "./passthrough";
import { runOllamaRestartRecovery } from "./passthrough-ollama-recovery";

function makeProcMock() {
  const writes: string[] = [];
  return {
    writes,
    proc: { stderr: { write: (value: string) => writes.push(value) } },
  };
}

describe("runOllamaRestartRecovery", () => {
  it.each([
    ["auth proxy", "http://host.openshell.internal:11435/v1"],
    ["WSL direct bridge", "http://host.openshell.internal:11434/v1"],
  ])("forwards the persisted %s route to recovery", (_name, endpointUrl) => {
    const recoverOllama = vi.fn(() => ({
      kind: "skipped" as const,
      reason: "already-loaded" as const,
    }));
    const { writes, proc } = makeProcMock();
    const route = {
      provider: "ollama-local",
      model: "qwen3.6:35b",
      endpointUrl,
    };

    runOllamaRestartRecovery(route, proc, recoverOllama);

    expect(recoverOllama).toHaveBeenCalledWith(route);
    expect(writes.join("")).toContain("Ollama model 'qwen3.6:35b' is already loaded");
  });

  it("reports a successful warm-up", () => {
    const { writes, proc } = makeProcMock();

    runOllamaRestartRecovery({ provider: "ollama-local", model: "qwen3.6:35b" }, proc, () => ({
      kind: "warmed",
      ok: true,
      timedOut: false,
    }));

    expect(writes.join("")).toContain("Ollama model 'qwen3.6:35b' is loaded and ready");
  });

  it("reports a timeout before continuing to OpenClaw", () => {
    const { writes, proc } = makeProcMock();

    runOllamaRestartRecovery({ provider: "ollama-local", model: "qwen3.6:35b" }, proc, () => ({
      kind: "warmed",
      ok: false,
      timedOut: true,
      reason: "timeout",
    }));

    const stderr = writes.join("");
    expect(stderr).toContain("Checking Ollama model readiness after daemon restart");
    expect(stderr).toContain("Ollama warm-up for 'qwen3.6:35b' timed out");
    expect(stderr).toContain("continuing to OpenClaw dispatch");
  });

  it.each([
    ["command-failed", "curl exited unsuccessfully"],
    ["ollama-error", "Ollama returned an error"],
    ["invalid-response", "Ollama returned an invalid response"],
    ["spawn-failed", "the warm-up process could not start"],
  ] as const)("reports a %s warm-up failure", (reason, message) => {
    const { writes, proc } = makeProcMock();

    runOllamaRestartRecovery({ provider: "ollama-local", model: "qwen3.6:35b" }, proc, () => ({
      kind: "warmed",
      ok: false,
      timedOut: false,
      reason,
    }));

    expect(writes.join("")).toContain(message);
  });

  it.each([
    ["already-loaded", "Ollama model 'qwen3.6:35b' is already loaded"],
    ["unreachable", "Ollama was unreachable during the restart check"],
    ["missing-model", "No Ollama model is recorded for this sandbox"],
    ["not-ollama", "Checking Ollama model readiness after daemon restart"],
  ] as const)("handles the %s skip reason", (reason, message) => {
    const { writes, proc } = makeProcMock();

    runOllamaRestartRecovery({ provider: "ollama-local", model: "qwen3.6:35b" }, proc, () => ({
      kind: "skipped",
      reason,
    }));

    expect(writes.join("")).toContain(message);
  });

  it("contains an unexpected recovery exception", () => {
    const { writes, proc } = makeProcMock();

    expect(() =>
      runOllamaRestartRecovery({ provider: "ollama-local", model: "qwen3.6:35b" }, proc, () => {
        throw new Error("unexpected");
      }),
    ).not.toThrow();
    expect(writes.join("")).toContain(
      "Ollama restart recovery failed unexpectedly; continuing to OpenClaw dispatch",
    );
  });
});

function makePassthroughDeps(
  route: { provider: string; model: string; endpointUrl: string },
  events: string[],
): AgentPassthroughDeps {
  return {
    getSandbox: ((name) => ({ name, agent: "openclaw", ...route })) as NonNullable<
      AgentPassthroughDeps["getSandbox"]
    >,
    ensureLive: (async () => ({ state: "present", output: "Phase: Ready" })) as NonNullable<
      AgentPassthroughDeps["ensureLive"]
    >,
    exec: (async () => {
      events.push("dispatch");
    }) as NonNullable<AgentPassthroughDeps["exec"]>,
    getRecentShieldsAutoRestore: () => ({ kind: "none" }),
    process: {
      exit: ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as (code: number) => never,
      stdout: { write: () => true },
      stderr: { write: () => true },
    },
  };
}

describe("agent passthrough Ollama recovery ordering", () => {
  it("checks an auth-proxy route before JSON dispatch", async () => {
    const events: string[] = [];
    const route = {
      provider: "ollama-local",
      model: "qwen3.6:35b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
    };
    const deps = makePassthroughDeps(route, events);
    const runRecovery = vi.fn(() => {
      events.push("recovery");
    });
    const execJson = vi.fn(((): never => {
      events.push("dispatch");
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping", "--json"] },
        { ...deps, execJson, runOllamaRestartRecovery: runRecovery },
      ),
    ).rejects.toThrow("__exit:0");

    expect(runRecovery).toHaveBeenCalledWith(expect.objectContaining(route), deps.process);
    expect(events).toEqual(["recovery", "dispatch"]);
  });

  it("checks a WSL direct route before non-JSON dispatch", async () => {
    const events: string[] = [];
    const route = {
      provider: "ollama-local",
      model: "qwen3.6:35b",
      endpointUrl: "http://host.openshell.internal:11434/v1",
    };
    const deps = makePassthroughDeps(route, events);
    const runRecovery = vi.fn(() => {
      events.push("recovery");
    });

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "main", "-m", "ping"] },
      { ...deps, runOllamaRestartRecovery: runRecovery },
    );

    expect(runRecovery).toHaveBeenCalledWith(expect.objectContaining(route), deps.process);
    expect(events).toEqual(["recovery", "dispatch"]);
  });

  it("does not run Ollama recovery for a non-Ollama route", async () => {
    const events: string[] = [];
    const deps = makePassthroughDeps(
      {
        provider: "vllm-local",
        model: "meta/llama",
        endpointUrl: "http://host.openshell.internal:8000/v1",
      },
      events,
    );
    const runRecovery = vi.fn();

    await runAgentPassthrough(
      "alpha",
      { extraArgs: ["--agent", "main", "-m", "ping"] },
      { ...deps, runOllamaRestartRecovery: runRecovery },
    );

    expect(runRecovery).not.toHaveBeenCalled();
    expect(events).toEqual(["dispatch"]);
  });
});
