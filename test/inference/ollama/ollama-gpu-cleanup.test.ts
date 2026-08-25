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

/** Answer /api/ps with the named models loaded, and every other call with an empty 200. */
function respondWithLoadedModels(...names: string[]) {
  return ({ args }: SpawnCall): SpawnSyncReturns<string> =>
    args.some((a) => a.endsWith("/api/ps"))
      ? ok(JSON.stringify({ models: names.map((name) => ({ name })) }))
      : ok();
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
      ({ args }) => {
        if (args.some((a) => a.endsWith("/api/ps"))) {
          return ok(JSON.stringify({ models: [{ name: "llama3.1:8b" }, { name: "qwen:7b" }] }));
        }
        return ok();
      },
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        unloadOllamaModels();

        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(3);

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

  it("returns silently when /api/ps fails (Ollama not running)", () => {
    withMockedSpawnSync(
      () => fail(),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        expect(() => unloadOllamaModels()).not.toThrow();
        expect(calls).toHaveLength(1);
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
        unloadOllamaModels();
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("ignores malformed JSON from /api/ps without throwing", () => {
    withMockedSpawnSync(
      ({ args }) => {
        if (args.some((a) => a.endsWith("/api/ps"))) {
          return ok("not-json");
        }
        return ok();
      },
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        expect(() => unloadOllamaModels()).not.toThrow();
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("unloads only the named models when a filter is supplied (#9110)", () => {
    withMockedSpawnSync(
      respondWithLoadedModels("keep-me:7b", "drop-me:7b"),
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        unloadOllamaModels(["drop-me:7b"]);

        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(2);
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
        unloadOllamaModels([]);

        const curlCalls = calls.filter(({ command }) => command === "curl");
        expect(curlCalls).toHaveLength(3);
        expect(unloadRequests(curlCalls)).toEqual([unloadOf("one:7b"), unloadOf("two:7b")]);
      },
    );
  });
});
