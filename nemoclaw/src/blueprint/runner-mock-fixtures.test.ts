// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createRunnerFsStore,
  inMemoryFsMethods,
  throwOnCall,
} from "./runner-mock-fixtures.js";
import { sandboxIdentityResult, sequentialCommandResult } from "./runner-test-fixtures.js";

describe("blueprint runner mock fixtures", () => {
  it("uses direct filesystem methods when no spy wrapper is supplied", () => {
    const { store } = createRunnerFsStore();
    const memory = inMemoryFsMethods(store);

    expect(memory.existsSync("/sandbox")).toBe(false);
    memory.mkdirSync("/sandbox");
    expect(memory.existsSync("/sandbox")).toBe(true);
  });

  it("models durable file descriptors and missing filesystem entries (#9833)", () => {
    const { store } = createRunnerFsStore();
    const memory = inMemoryFsMethods(store);

    expect(() => memory.openSync("/missing")).toThrow(/ENOENT/u);
    expect(() => memory.renameSync("/missing", "/renamed")).toThrow(/ENOENT/u);

    memory.writeFileSync("/receipt", "complete");
    const fd = memory.openSync("/receipt");
    expect(() => memory.fsyncSync(fd)).not.toThrow();
    expect(() => memory.closeSync(fd)).not.toThrow();
    expect(() => memory.fsyncSync(fd)).toThrow(`EBADF: ${fd}`);
    expect(() => memory.closeSync(fd)).toThrow(`EBADF: ${fd}`);
  });

  it("throws only on the selected callback invocation", () => {
    const failure = new Error("selected failure");
    const callback = throwOnCall(2, failure);

    expect(callback).not.toThrow();
    expect(callback).toThrow(failure);
    expect(callback).not.toThrow();
  });

  it("models sandbox identity and sequential command responses", () => {
    expect(sandboxIdentityResult("alpha", "sandbox-7", "Stopped")).toEqual({
      exitCode: 0,
      stdout: "Name: alpha\nId: sandbox-7\nPhase: Stopped\n",
      stderr: "",
    });

    const first = { exitCode: 1, stdout: "", stderr: "not ready" };
    const second = { exitCode: 0, stdout: "ready", stderr: "" };
    const nextResult = sequentialCommandResult("sandbox get alpha", [first, second]);

    expect(nextResult(["sandbox", "get", "other"])).toBeUndefined();
    expect(nextResult(["sandbox", "get", "alpha"])).toBe(first);
    expect(nextResult(["sandbox", "get", "alpha"])).toBe(second);
    expect(nextResult(["sandbox", "get", "alpha"])).toBe(second);
  });
});
