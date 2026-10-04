// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/adapters/docker/index.ts")>()),
  detectContainerRuntimeFromDockerInfo: vi.fn(() => "docker-desktop"),
}));
vi.mock("../../../src/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/platform.ts")>()),
  containerCanReachHostLoopback: vi.fn(() => true),
}));

import {
  findReachableOllamaHost,
  loadPersistedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  persistResolvedOllamaHost,
  prepareOllamaApiExecution,
  resetOllamaHostCache,
  setResolvedOllamaHost,
} from "../../../src/lib/inference/local.js";
import { unloadOllamaModels as unloadOllamaModelsImpl } from "../../../src/lib/inference/ollama/proxy.js";

type SpawnCall = {
  command: string;
  args: readonly string[];
  options?: { env?: NodeJS.ProcessEnv };
};
type SpawnSync = (typeof import("node:child_process"))["spawnSync"];
type OllamaModules = {
  unloadOllamaModels: (typeof import("../../../src/lib/inference/ollama/proxy.ts"))["unloadOllamaModels"];
};

function ok(stdout = ""): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ["", stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  };
}

function fail(stderr = "couldn't connect"): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ["", "", stderr],
    stdout: "",
    stderr,
    status: 7,
    signal: null,
  };
}

function isolatedDockerEnvironment() {
  return {
    env: {},
    isolatedCredentialConfig: false,
    cleanup: () => ({ ok: true as const }),
  };
}

const WINDOWS_WSL_DETECTION = {
  isWsl: true,
  env: { DOCKER_CONTEXT: "default" },
} as const;

const windowsRouteProtectionCapture = (command: readonly string[]): string => {
  const rendered = command.join(" ");
  return rendered.includes("Get-NetTCPConnection")
    ? "127.0.0.1"
    : command.includes("Host: rebinding.invalid")
      ? "403"
      : JSON.stringify({ models: [] });
};

const prepareProtectedOllamaApiExecution: typeof prepareOllamaApiExecution = (
  command,
  host,
  options,
) =>
  prepareOllamaApiExecution(command, host, {
    ...options,
    runCaptureImpl: windowsRouteProtectionCapture,
  });

function withMockedSpawnSync<T>(
  responder: (call: SpawnCall) => SpawnSyncReturns<string>,
  fn: (calls: SpawnCall[], modules: OllamaModules) => T | Promise<T>,
  ollamaHost = "127.0.0.1",
): T | Promise<T> {
  const calls: SpawnCall[] = [];
  const spawnSync = ((
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    const call = { command, args, options };
    calls.push(call);
    return responder(call);
  }) as SpawnSync;
  const unloadOllamaModels: typeof unloadOllamaModelsImpl = (onlyModels, options) =>
    unloadOllamaModelsImpl(onlyModels, {
      ...options,
      findReachableOllamaHost: () => ollamaHost,
      prepareOllamaApiExecution: prepareProtectedOllamaApiExecution,
      spawnSync,
    });
  return fn(calls, { unloadOllamaModels });
}

/** Report the named models until their keep_alive:0 request succeeds. */
function respondWithLoadedModels(...names: string[]) {
  const loaded = new Set(names);
  return ({ args }: SpawnCall): SpawnSyncReturns<string> =>
    args.some((arg) => arg.endsWith("/api/ps"))
      ? ok(JSON.stringify({ models: [...loaded].map((name) => ({ name })) }))
      : (args.includes("POST") &&
          loaded.delete((JSON.parse(args[args.indexOf("-d") + 1]) as { model: string }).model),
        ok());
}

/** The endpoint path and POST body of each unload request, in the order issued. */
function unloadRequests(calls: readonly SpawnCall[]) {
  return calls
    .filter(({ args }) => args.includes("POST"))
    .map(({ args }) => ({
      target: new URL(args[args.length - 1]).pathname,
      body: args[args.indexOf("-d") + 1],
    }));
}

function unloadOf(model: string) {
  return { target: "/api/generate", body: JSON.stringify({ model, keep_alive: 0 }) };
}

describe("Ollama GPU cleanup", () => {
  beforeEach(() => {
    vi.stubEnv("DOCKER_CONTEXT", "default");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("restores the persisted Windows-host transport after the process cache is cleared", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-cleanup-route-"));
    const calls: SpawnCall[] = [];
    const capture = vi.fn((command: readonly string[]) => {
      const rendered = command.join(" ");
      return rendered.includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "403"
          : rendered.includes("host.docker.internal:11434/api/tags")
            ? JSON.stringify({ models: [] })
            : "";
    });
    const respond = respondWithLoadedModels("llama3.2:1b");
    const spawnSync = ((command: string, args: readonly string[]) => {
      const call = { command, args };
      calls.push(call);
      return respond(call);
    }) as SpawnSync;

    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      const result = unloadOllamaModelsImpl(["llama3.2:1b"], {
        findReachableOllamaHost: (root) =>
          findReachableOllamaHost(capture, WINDOWS_WSL_DETECTION, root, {
            runtime: "docker-desktop",
            prepareDockerEnvironment: isolatedDockerEnvironment,
          }),
        ollamaHostStateRoot: stateRoot,
        prepareOllamaApiExecution: prepareProtectedOllamaApiExecution,
        sleep: () => {},
        spawnSync,
      });

      expect(result).toMatchObject({
        ok: true,
        outcome: "released",
        endpoint: "http://host.docker.internal:11434",
      });
      expect(calls).toHaveLength(3);
      expect(
        capture.mock.calls.some(([command]) => command.includes("Host: rebinding.invalid")),
      ).toBe(true);
      calls.forEach(({ command, args }) => {
        expect(command).toBe("docker");
        expect(args).toEqual(
          expect.arrayContaining([
            "run",
            "--rm",
            "docker.io/curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
          ]),
        );
      });
    } finally {
      resetOllamaHostCache();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not unload through a persisted Windows route when protection fails", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "nemoclaw-ollama-cleanup-rebinding-"));
    const spawnSync = vi.fn(() => ok()) as unknown as SpawnSync;
    const capture = vi.fn((command: readonly string[]) => {
      const rendered = command.join(" ");
      return rendered.includes("Get-NetTCPConnection")
        ? "127.0.0.1"
        : command.includes("Host: rebinding.invalid")
          ? "200"
          : rendered.includes("host.docker.internal:11434/api/tags")
            ? JSON.stringify({ models: [] })
            : "";
    });

    try {
      persistResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL, stateRoot);
      resetOllamaHostCache();
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);

      const result = unloadOllamaModelsImpl(["llama3.2:1b"], {
        findReachableOllamaHost: (root) =>
          findReachableOllamaHost(capture, WINDOWS_WSL_DETECTION, root, {
            runtime: "docker-desktop",
            prepareDockerEnvironment: isolatedDockerEnvironment,
            revalidate: true,
          }),
        ollamaHostStateRoot: stateRoot,
        spawnSync,
      });

      expect(result).toMatchObject({
        ok: false,
        outcome: "discovery-failed",
        requests: [],
      });
      expect(spawnSync).not.toHaveBeenCalled();
      expect(loadPersistedOllamaHost(stateRoot)).toBeNull();
    } finally {
      resetOllamaHostCache();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("uses the resolved local Ollama host for discovery, release, and verification (#10074)", async () => {
    await withMockedSpawnSync(
      respondWithLoadedModels("llama3.2:1b"),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({
          ok: true,
          outcome: "released",
          endpoint: "http://host.docker.internal:11434",
        });
        const dockerCalls = calls.filter(({ command }) => command === "docker");
        expect(dockerCalls).toHaveLength(3);
        expect(dockerCalls.map(({ args }) => args.at(-1))).toEqual([
          "http://host.docker.internal:11434/api/ps",
          "http://host.docker.internal:11434/api/generate",
          "http://host.docker.internal:11434/api/ps",
        ]);
        dockerCalls.forEach(({ args }) => {
          expect(args).toEqual(
            expect.arrayContaining([
              "run",
              "--rm",
              "docker.io/curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
            ]),
          );
        });
      },
      "host.docker.internal",
    );
  });

  it("retains cleanup recovery when no local Ollama endpoint is reachable", () => {
    const result = unloadOllamaModelsImpl(["llama3.2:1b"], {
      findReachableOllamaHost: () => null,
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "discovery-failed",
      endpoint: "http://127.0.0.1:11434",
      selectedModels: ["llama3.2:1b"],
      discoveries: [],
      requests: [],
      message: "No reachable local Ollama endpoint was found for cleanup",
    });
  });

  it("isolates Docker credentials for discovery, release, and verification", () => {
    const calls: SpawnCall[] = [];
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const respond = respondWithLoadedModels("llama3.2:1b");
    const spawnSync = ((
      command: string,
      args: readonly string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      const call = { command, args, options };
      calls.push(call);
      return options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
        ? respond(call)
        : fail("ambient Docker config used");
    }) as SpawnSync;

    const result = unloadOllamaModelsImpl(["llama3.2:1b"], {
      findReachableOllamaHost: () => OLLAMA_HOST_DOCKER_INTERNAL,
      sleep: () => {},
      spawnSync,
      prepareOllamaApiExecution: (
        command: Parameters<typeof prepareOllamaApiExecution>[0],
        host: Parameters<typeof prepareOllamaApiExecution>[1],
        options: NonNullable<Parameters<typeof prepareOllamaApiExecution>[2]>,
      ) =>
        prepareOllamaApiExecution(command, host, {
          ...options,
          runCaptureImpl: windowsRouteProtectionCapture,
          prepareDockerEnvironment: () => ({
            env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
            isolatedCredentialConfig: true,
            cleanup,
          }),
        }),
    });

    expect(result).toMatchObject({ ok: true, outcome: "released" });
    expect(calls).toHaveLength(3);
    expect(calls.map(({ options }) => options?.env?.DOCKER_CONFIG)).toEqual([
      "/tmp/credential-free-docker",
      "/tmp/credential-free-docker",
      "/tmp/credential-free-docker",
    ]);
    expect(calls.map(({ args }) => args.at(-1))).toEqual([
      "http://host.docker.internal:11434/api/ps",
      "http://host.docker.internal:11434/api/generate",
      "http://host.docker.internal:11434/api/ps",
    ]);
    expect(cleanup).toHaveBeenCalledTimes(9);
  });

  it("unloads every running model through the Ollama API", async () => {
    await withMockedSpawnSync(
      respondWithLoadedModels("llama3.1:8b", "qwen:7b"),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels();

        expect(result).toMatchObject({
          ok: true,
          outcome: "released",
          endpoint: "http://127.0.0.1:11434",
          selectedModels: ["llama3.1:8b", "qwen:7b"],
        });
        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(4);

        expect(curlCalls[0].args).toContain("--max-time");
        expect(curlCalls[0].args[curlCalls[0].args.length - 1]).toMatch(/\/api\/ps$/);

        expect(curlCalls[1].args).toContain("-X");
        expect(curlCalls[1].args).toContain("POST");
        expect(curlCalls[1].args).toContain(
          JSON.stringify({ model: "llama3.1:8b", keep_alive: 0 }),
        );
        expect(curlCalls[1].args[curlCalls[1].args.length - 1]).toMatch(/\/api\/generate$/);

        expect(curlCalls[2].args).toContain(JSON.stringify({ model: "qwen:7b", keep_alive: 0 }));
      },
    );
  });

  it("returns bounded discovery failure evidence when /api/ps is unreachable (#10074)", async () => {
    await withMockedSpawnSync(
      () => fail(),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({
          ok: false,
          outcome: "discovery-failed",
          endpoint: "http://127.0.0.1:11434",
          selectedModels: ["llama3.2:1b"],
        });
        expect(result.discoveries).toHaveLength(3);
        expect(result.discoveries[2]).toMatchObject({ attempt: 3, status: 7 });
        expect(calls).toHaveLength(3);
        expect(calls[0].args[calls[0].args.length - 1]).toMatch(/\/api\/ps$/);
      },
    );
  });

  it("does not unload anything when Ollama reports no loaded models", async () => {
    await withMockedSpawnSync(
      ({ args }) => {
        if (args.some((a) => a.endsWith("/api/ps"))) {
          return ok(JSON.stringify({ models: [] }));
        }
        return ok();
      },
      (calls, { unloadOllamaModels }) => {
        expect(unloadOllamaModels()).toMatchObject({ ok: true, outcome: "not-resident" });
        expect(calls).toHaveLength(1);
      },
    );
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["a missing models array", "{}"],
    ["a malformed model row", JSON.stringify({ models: [{}] })],
  ])("returns discovery failure evidence for %s from /api/ps (#10074)", async (_label, body) => {
    await withMockedSpawnSync(
      ({ args }) => (args.some((a) => a.endsWith("/api/ps")) ? ok(body) : ok()),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"]);

        expect(result).toMatchObject({ ok: false, outcome: "discovery-failed" });
        expect(result.discoveries[0].error).toContain("Ollama /api/ps");
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("unloads only the named models when a filter is supplied (#9110)", async () => {
    await withMockedSpawnSync(
      respondWithLoadedModels("keep-me:7b", "drop-me:7b"),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["drop-me:7b"]);

        expect(result).toMatchObject({ ok: true, outcome: "released" });
        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(3);
        expect(unloadRequests(curlCalls)).toEqual([unloadOf("drop-me:7b")]);
      },
    );
  });

  it.each([
    ["an untagged filter against a tagged daemon entry", "llama3", "llama3:latest"],
    ["a tagged filter against an untagged daemon entry", "llama3:latest", "llama3"],
  ])("matches %s (#9110)", async (_label, filterRef, loadedRef) => {
    await withMockedSpawnSync(
      respondWithLoadedModels(loadedRef),
      (calls, { unloadOllamaModels }) => {
        unloadOllamaModels([filterRef]);

        expect(unloadRequests(calls)).toEqual([unloadOf(loadedRef)]);
      },
    );
  });

  it("unloads every loaded model when the filter is empty (#9110)", async () => {
    await withMockedSpawnSync(
      respondWithLoadedModels("one:7b", "two:7b"),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels([]);

        expect(result).toMatchObject({ ok: true, outcome: "released" });
        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(4);
        expect(unloadRequests(curlCalls)).toEqual([unloadOf("one:7b"), unloadOf("two:7b")]);
      },
    );
  });

  it("does not turn a blank scoped filter into a host-wide unload (#10074)", async () => {
    await withMockedSpawnSync(
      respondWithLoadedModels("keep-me:7b"),
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["   "]);

        expect(result).toMatchObject({ ok: true, outcome: "not-resident", selectedModels: [] });
        expect(unloadRequests(calls)).toEqual([]);
      },
    );
  });

  it("surfaces a rejected unload POST without retrying a non-transient response (#10074)", async () => {
    await withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
          : { ...fail("HTTP 500"), status: 22 },
      (calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({
          ok: false,
          outcome: "unload-request-failed",
          message: "HTTP 500",
        });
        expect(result.requests).toEqual([
          expect.objectContaining({ attempt: 1, model: "llama3.2:1b", status: 22 }),
        ]);
        expect(calls).toHaveLength(2);
      },
    );
  });

  it("retries a transient unload failure within the bounded attempt count (#10074)", async () => {
    let postCount = 0;
    let loaded = true;
    await withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: loaded ? [{ name: "llama3.2:1b" }] : [] }))
          : ((postCount += 1),
            postCount === 1 ? fail("connection reset") : ((loaded = false), ok())),
      (_calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({ ok: true, outcome: "released" });
        expect(
          result.requests.map(
            ({ attempt, status }: { attempt: number; status: number | null }) => ({
              attempt,
              status,
            }),
          ),
        ).toEqual([
          { attempt: 1, status: 7 },
          { attempt: 2, status: 0 },
        ]);
      },
    );
  });

  it("fails after bounded verification while the selected model remains resident (#10074)", async () => {
    await withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
          : ok(),
      (_calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({
          ok: false,
          outcome: "still-resident",
          message: "Ollama still reports: llama3.2:1b",
        });
        expect(result.requests).toHaveLength(3);
        expect(result.discoveries.at(-1)).toMatchObject({
          attempt: 3,
          matchedModels: ["llama3.2:1b"],
        });
      },
    );
  });

  it("surfaces malformed post-release /api/ps verification (#10074)", async () => {
    let discoveryCount = 0;
    await withMockedSpawnSync(
      ({ args }) =>
        !args.some((arg) => arg.endsWith("/api/ps"))
          ? ok()
          : ((discoveryCount += 1),
            discoveryCount === 1
              ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
              : ok("not-json")),
      (_calls, { unloadOllamaModels }) => {
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({ ok: false, outcome: "discovery-failed" });
        expect(result.discoveries.at(-1)?.error).toContain("malformed JSON");
      },
    );
  });
});
