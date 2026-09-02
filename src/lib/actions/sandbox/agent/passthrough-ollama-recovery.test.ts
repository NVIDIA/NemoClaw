// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { type AgentPassthroughDeps, runAgentPassthrough } from "./passthrough";
import { requestedAgentTimeoutSeconds } from "./passthrough-dispatch";
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
  ])("forwards the persisted %s route to recovery", async (_name, endpointUrl) => {
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

    await runOllamaRestartRecovery(route, proc, {}, recoverOllama);

    expect(recoverOllama).toHaveBeenCalledWith(route, {});
    expect(writes.join("")).toContain("Ollama model 'qwen3.6:35b' is already loaded");
  });

  it("reports a successful warm-up", async () => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      {},
      () => ({ kind: "warmed", ok: true }),
    );

    expect(writes.join("")).toContain("Ollama model 'qwen3.6:35b' is loaded and ready");
  });

  it("reports a timeout before continuing to OpenClaw", async () => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      {},
      () => ({
        kind: "warmed",
        ok: false,
        reason: "timeout",
        endpoint: "http://host.docker.internal:11434",
        detail: "curl timed out after 300 seconds",
      }),
    );

    const stderr = writes.join("");
    expect(stderr).toContain("Checking whether the Ollama model is loaded");
    expect(stderr).toContain("Ollama warm-up for 'qwen3.6:35b'");
    expect(stderr).toContain("timed out");
    expect(stderr).toContain("at http://host.docker.internal:11434");
    expect(stderr).toContain("OpenClaw dispatch will continue");
    expect(stderr).toContain("confirm that it serves 'qwen3.6:35b'");
    expect(stderr).toContain("NemoClaw will retry the warm-up before the next agent command");
    expect(stderr).not.toContain("rerun this command");
  });

  it.each([
    ["command-failed", "curl exited unsuccessfully"],
    ["ollama-error", "Ollama returned an error"],
    ["invalid-response", "Ollama returned an invalid response"],
    ["spawn-failed", "the warm-up process could not start"],
  ] as const)("reports a %s warm-up failure", async (reason, message) => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      {},
      () => ({
        kind: "warmed",
        ok: false,
        reason,
        endpoint: "http://host.docker.internal:11434",
        detail: "bounded failure detail",
      }),
    );

    const stderr = writes.join("");
    expect(stderr).toContain(message);
    expect(stderr).toContain("http://host.docker.internal:11434");
    expect(stderr).toContain("OpenClaw dispatch will continue");
    expect(stderr).toContain("confirm that it serves 'qwen3.6:35b'");
    expect(stderr).toContain("NemoClaw will retry the warm-up before the next agent command");
    expect(stderr).not.toContain("rerun this command");
  });

  it.each([
    ["already-loaded", "Ollama model 'qwen3.6:35b' is already loaded"],
    ["missing-model", "No Ollama model is recorded for this sandbox"],
    ["not-ollama", "Checking whether the Ollama model is loaded"],
  ] as const)("reports the diagnostic for the %s recovery result", async (reason, message) => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      {},
      () => ({ kind: "skipped", reason }),
    );

    expect(writes.join("")).toContain(message);
  });

  it("reports the endpoint, model, and recovery action when Ollama is unreachable", async () => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      {},
      () => ({
        kind: "skipped",
        reason: "unreachable",
        endpoint: "http://host.docker.internal:11434",
      }),
    );

    const stderr = writes.join("");
    expect(stderr).toContain("http://host.docker.internal:11434");
    expect(stderr).toContain("qwen3.6:35b");
    expect(stderr).toContain("Restore Ollama access");
    expect(stderr).toContain("confirm that it serves");
    expect(stderr).toContain("NemoClaw will retry the warm-up before the next agent command");
    expect(stderr).not.toContain("rerun this command");
  });

  it("reports a warm-up skipped after the command timeout budget is exhausted", async () => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      proc,
      { timeoutSeconds: 1 },
      () => ({
        kind: "skipped",
        reason: "deadline-exhausted",
        endpoint: "http://host.docker.internal:11434",
      }),
    );

    const stderr = writes.join("");
    expect(stderr).toContain("warm-up for 'qwen3.6:35b'");
    expect(stderr).toContain("http://host.docker.internal:11434");
    expect(stderr).toContain("was skipped");
    expect(stderr).toContain("timeout left no recovery budget");
    expect(stderr).toContain("continuing to OpenClaw dispatch");
  });

  it("names the endpoint and its reported models when the model is absent (#9455)", async () => {
    const { writes, proc } = makeProcMock();

    await runOllamaRestartRecovery(
      {
        provider: "ollama-local",
        model: "gemma4:26b",
        endpointUrl: "http://host.openshell.internal:11434/v1",
      },
      proc,
      {},
      () => ({
        kind: "skipped",
        reason: "model-absent",
        endpoint: "http://host.docker.internal:11434",
        inventoryLabel: "llama3.2:1b",
      }),
    );

    const stderr = writes.join("");
    expect(stderr).toContain(
      "Ollama at http://host.docker.internal:11434 reports 'gemma4:26b' as unavailable",
    );
    expect(stderr).toContain("reported models: llama3.2:1b");
    expect(stderr).toContain("continuing to OpenClaw dispatch");
    expect(stderr).toContain("Restart the daemon that holds 'gemma4:26b'");
    expect(stderr).not.toContain("Ollama was unreachable during the restart check");
  });

  it("redacts and bounds recovery exceptions", async () => {
    const { writes, proc } = makeProcMock();
    const exposedToken = "sk-proj-NOT-A-REAL-SECRET-1234567890";
    const directionalControls =
      "\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";

    await expect(
      runOllamaRestartRecovery(
        {
          provider: "ollama-local",
          model: `qwen3.6:35b${directionalControls}\u001b[2J\u0007`,
          endpointUrl: `http://host.openshell.internal:11434/v1${directionalControls}\u001b]52;c;clipboard\u0007`,
        },
        proc,
        {},
        () => {
          throw new Error(
            `synthetic\u001b[2J Docker transport failure\u0007 OPENAI_API_KEY=${exposedToken} ${"x".repeat(400)} END-OF-DETAIL`,
          );
        },
      ),
    ).resolves.toBeNull();
    const stderr = writes.join("");
    expect(stderr).toContain("Ollama restart recovery for 'qwen3.6:35b");
    expect(stderr).toContain("at the recorded endpoint http://host.openshell.internal:11434/v1");
    expect(stderr).toContain("synthetic");
    expect(stderr).toContain("Docker transport failure");
    expect(stderr).toContain("OPENAI_API_KEY=<REDACTED>");
    expect(stderr).toContain("OpenClaw dispatch will continue");
    expect(stderr).toContain("Restore Ollama access to that endpoint");
    expect(stderr).toContain("NemoClaw will retry the warm-up before the next agent command");
    expect(stderr).not.toContain("rerun this command");
    expect(stderr).not.toContain(exposedToken);
    expect(stderr).not.toContain("END-OF-DETAIL");
    expect(stderr).not.toContain("\u001b");
    expect(stderr).not.toContain("\u0007");
    expect(stderr.replace(/\n/gu, "")).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
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
    ensureLive: (async () => ({
      state: "present",
      phase: "Ready",
      output: "Phase: Ready",
    })) as NonNullable<AgentPassthroughDeps["ensureLive"]>,
    execNonJson: ((): never => {
      events.push("dispatch");
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>,
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

    expect(runRecovery).toHaveBeenCalledWith(expect.objectContaining(route), deps.process, {});
    expect(events).toEqual(["recovery", "dispatch"]);
  });

  it.each([
    ["partial recovery", 5_000, 25],
    ["an exhausted recovery budget", 30_000, 1],
  ])(
    "reduces a 30-second timeout after %s",
    async (_name, elapsedMilliseconds, expectedTimeout) => {
      const events: string[] = [];
      const dispatchedTimeouts: number[] = [];
      const route = {
        provider: "ollama-local",
        model: "qwen3.6:35b",
        endpointUrl: "http://host.openshell.internal:11434/v1",
      };
      const deps = makePassthroughDeps(route, events);
      const now = vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(elapsedMilliseconds);
      const runRecovery = vi.fn(() => {
        events.push("recovery");
      });
      const execNonJson = vi.fn(((
        _sandboxName: string,
        dispatchedCommand: readonly string[],
      ): never => {
        dispatchedTimeouts.push(requestedAgentTimeoutSeconds(dispatchedCommand) ?? -1);
        events.push("dispatch");
        throw new Error("__exit:0");
      }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);

      await expect(
        runAgentPassthrough(
          "alpha",
          { extraArgs: ["--agent", "main", "--timeout", "30", "-m", "ping"] },
          { ...deps, execNonJson, now, runOllamaRestartRecovery: runRecovery },
        ),
      ).rejects.toThrow("__exit:0");

      expect(runRecovery).toHaveBeenCalledWith(expect.objectContaining(route), deps.process, {
        timeoutSeconds: 29,
      });
      expect(events).toEqual(["recovery", "dispatch"]);
      expect(dispatchedTimeouts).toEqual([expectedTimeout]);
    },
  );

  it("dispatches after reporting an Ollama recovery exception", async () => {
    const events: string[] = [];
    const diagnostics: string[] = [];
    const route = {
      provider: "ollama-local",
      model: "qwen3.6:35b",
      endpointUrl: "http://host.openshell.internal:11434/v1",
    };
    const deps = makePassthroughDeps(route, events);
    deps.process = {
      ...deps.process!,
      stderr: {
        write: (value: string) => {
          diagnostics.push(value);
          value.includes("failed unexpectedly") && events.push("diagnostic");
          return true;
        },
      },
    };
    const runRecovery = (
      registeredRoute: Parameters<typeof runOllamaRestartRecovery>[0],
      proc: Parameters<typeof runOllamaRestartRecovery>[1],
    ) =>
      runOllamaRestartRecovery(registeredRoute, proc, {}, () => {
        throw new Error("synthetic recovery failure");
      });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping"] },
        { ...deps, runOllamaRestartRecovery: runRecovery },
      ),
    ).rejects.toThrow("__exit:0");

    expect(events).toEqual(["diagnostic", "dispatch"]);
    expect(diagnostics.join("")).toContain("failed unexpectedly");
  });

  it("does not dispatch after Ollama recovery receives SIGTERM", async () => {
    const events: string[] = [];
    const route = {
      provider: "ollama-local",
      model: "qwen3.6:35b",
      endpointUrl: "http://host.openshell.internal:11434/v1",
    };
    const deps = makePassthroughDeps(route, events);
    const runRecovery = vi.fn(async () => {
      events.push("recovery-cancelled");
      return "SIGTERM" as const;
    });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping"] },
        { ...deps, runOllamaRestartRecovery: runRecovery },
      ),
    ).rejects.toThrow("__exit:143");

    expect(events).toEqual(["recovery-cancelled"]);
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

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping"] },
        { ...deps, runOllamaRestartRecovery: runRecovery },
      ),
    ).rejects.toThrow("__exit:0");

    expect(runRecovery).not.toHaveBeenCalled();
    expect(events).toEqual(["dispatch"]);
  });
});
