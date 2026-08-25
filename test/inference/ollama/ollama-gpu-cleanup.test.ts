// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess, { type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = path.join(
  import.meta.dirname,
  "../../..",
  "src",
  "lib",
  "inference",
  "ollama",
  "proxy.ts",
);

type SpawnCall = { command: string; args: readonly string[] };

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

function withMockedSpawnSync<T>(
  responder: (call: SpawnCall) => SpawnSyncReturns<string>,
  fn: (calls: SpawnCall[]) => T,
): T {
  const calls: SpawnCall[] = [];
  const original = childProcess.spawnSync;
  // @ts-expect-error — partial mock signature is intentional.
  childProcess.spawnSync = (command: string, args: readonly string[]) => {
    const call = { command, args };
    calls.push(call);
    return responder(call);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    return fn(calls);
  } finally {
    childProcess.spawnSync = original;
    delete require.cache[require.resolve(modulePath)];
  }
}

/** Report the named models until their keep_alive:0 request succeeds. */
function respondWithLoadedModels(...names: string[]) {
  const loaded = new Set(names);
  return ({ args }: SpawnCall): SpawnSyncReturns<string> =>
    args.some((arg) => arg.endsWith("/api/ps"))
      ? ok(JSON.stringify({ models: [...loaded].map((name) => ({ name })) }))
      : (args.includes("POST") &&
          loaded.delete(
            (JSON.parse(args[args.indexOf("-d") + 1]) as { model: string }).model,
          ),
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
  it("calls curl synchronously to unload every running model via /api/generate", () => {
    withMockedSpawnSync(
      respondWithLoadedModels("llama3.1:8b", "qwen:7b"),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
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

  it("returns bounded discovery failure evidence when /api/ps is unreachable (#10074)", () => {
    withMockedSpawnSync(
      () => fail(),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
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

  it("does not unload anything when Ollama reports no loaded models", () => {
    withMockedSpawnSync(
      ({ args }) => {
        if (args.some((a) => a.endsWith("/api/ps"))) {
          return ok(JSON.stringify({ models: [] }));
        }
        return ok();
      },
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        expect(unloadOllamaModels()).toMatchObject({ ok: true, outcome: "not-resident" });
        expect(calls).toHaveLength(1);
      },
    );
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["a missing models array", "{}"],
    ["a malformed model row", JSON.stringify({ models: [{}] })],
  ])("returns discovery failure evidence for %s from /api/ps (#10074)", (_label, body) => {
    withMockedSpawnSync(
      ({ args }) => (args.some((a) => a.endsWith("/api/ps")) ? ok(body) : ok()),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        const result = unloadOllamaModels(["llama3.2:1b"]);

        expect(result).toMatchObject({ ok: false, outcome: "discovery-failed" });
        expect(result.discoveries[0].error).toContain("Ollama /api/ps");
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("unloads only the named models when a filter is supplied (#9110)", () => {
    withMockedSpawnSync(
      respondWithLoadedModels("keep-me:7b", "drop-me:7b"),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
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
  ])("matches %s (#9110)", (_label, filterRef, loadedRef) => {
    withMockedSpawnSync(respondWithLoadedModels(loadedRef), (calls) => {
      const { unloadOllamaModels } = require(modulePath);
      unloadOllamaModels([filterRef]);

      expect(unloadRequests(calls)).toEqual([unloadOf(loadedRef)]);
    });
  });

  it("unloads every loaded model when the filter is empty (#9110)", () => {
    withMockedSpawnSync(
      respondWithLoadedModels("one:7b", "two:7b"),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        const result = unloadOllamaModels([]);

        expect(result).toMatchObject({ ok: true, outcome: "released" });
        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(4);
        expect(unloadRequests(curlCalls)).toEqual([unloadOf("one:7b"), unloadOf("two:7b")]);
      },
    );
  });

  it("does not turn a blank scoped filter into a host-wide unload (#10074)", () => {
    withMockedSpawnSync(respondWithLoadedModels("keep-me:7b"), (calls) => {
      const { unloadOllamaModels } = require(modulePath);
      const result = unloadOllamaModels(["   "]);

      expect(result).toMatchObject({ ok: true, outcome: "not-resident", selectedModels: [] });
      expect(unloadRequests(calls)).toEqual([]);
    });
  });

  it("surfaces a rejected unload POST without retrying a non-transient response (#10074)", () => {
    withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
          : { ...fail("HTTP 500"), status: 22 },
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
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

  it("retries a transient unload failure within the bounded attempt count (#10074)", () => {
    let postCount = 0;
    let loaded = true;
    withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: loaded ? [{ name: "llama3.2:1b" }] : [] }))
          : ((postCount += 1),
            postCount === 1 ? fail("connection reset") : ((loaded = false), ok())),
      () => {
        const { unloadOllamaModels } = require(modulePath);
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({ ok: true, outcome: "released" });
        expect(
          result.requests.map(({ attempt, status }: { attempt: number; status: number | null }) => ({
            attempt,
            status,
          })),
        ).toEqual([
          { attempt: 1, status: 7 },
          { attempt: 2, status: 0 },
        ]);
      },
    );
  });

  it("fails after bounded verification while the selected model remains resident (#10074)", () => {
    withMockedSpawnSync(
      ({ args }) =>
        args.some((arg) => arg.endsWith("/api/ps"))
          ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
          : ok(),
      () => {
        const { unloadOllamaModels } = require(modulePath);
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

  it("surfaces malformed post-release /api/ps verification (#10074)", () => {
    let discoveryCount = 0;
    withMockedSpawnSync(
      ({ args }) =>
        !args.some((arg) => arg.endsWith("/api/ps"))
          ? ok()
          : ((discoveryCount += 1),
            discoveryCount === 1
              ? ok(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }))
              : ok("not-json")),
      () => {
        const { unloadOllamaModels } = require(modulePath);
        const result = unloadOllamaModels(["llama3.2:1b"], { sleep: () => {} });

        expect(result).toMatchObject({ ok: false, outcome: "discovery-failed" });
        expect(result.discoveries.at(-1)?.error).toContain("malformed JSON");
      },
    );
  });
});
