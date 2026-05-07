// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess, { type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = path.join(
  import.meta.dirname,
  "..",
  "dist",
  "lib",
  "onboard-ollama-proxy.js",
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

describe("Ollama GPU cleanup", () => {
  it("calls curl synchronously to unload every running model via /api/generate", () => {
    withMockedSpawnSync(
      ({ args }) => {
        if (args.some((a) => a.endsWith("/api/ps"))) {
          return ok(
            JSON.stringify({ models: [{ name: "llama3.1:8b" }, { name: "qwen:7b" }] }),
          );
        }
        return ok();
      },
      (calls) => {
        const { unloadOllamaModels } = require(modulePath);
        unloadOllamaModels();

        expect(calls).toHaveLength(3);

        expect(calls[0].command).toBe("curl");
        expect(calls[0].args).toContain("--max-time");
        expect(calls[0].args[calls[0].args.length - 1]).toMatch(/\/api\/ps$/);

        expect(calls[1].command).toBe("curl");
        expect(calls[1].args).toContain("-X");
        expect(calls[1].args).toContain("POST");
        expect(calls[1].args).toContain(JSON.stringify({ model: "llama3.1:8b", keep_alive: 0 }));
        expect(calls[1].args[calls[1].args.length - 1]).toMatch(/\/api\/generate$/);

        expect(calls[2].args).toContain(JSON.stringify({ model: "qwen:7b", keep_alive: 0 }));
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
});
