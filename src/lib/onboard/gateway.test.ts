// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../runner", () => ({
  ROOT: "/repo/root",
}));

import { streamGatewayStart } from "./gateway";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("streamGatewayStart", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("bounds retained diagnostics while preserving initial and terminal evidence", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = streamGatewayStart("openshell gateway start", {
      NEMOCLAW_GATEWAY_START_TIMEOUT: "60",
    });

    child.stdout.emit("data", Buffer.from("initial failure signature\n"));
    for (let index = 0; index < 8; index += 1) {
      child.stdout.emit("data", Buffer.from(`${String(index)}:${"x".repeat(64 * 1024)}\n`));
    }
    child.stderr.emit("data", Buffer.from("terminal diagnostic\n"));
    child.emit("close", 1);

    const result = await resultPromise;
    expect(result.status).toBe(1);
    expect(result.output).toContain("initial failure signature");
    expect(result.output).toContain("terminal diagnostic");
    expect(result.output).toContain("transcript characters omitted");
    expect(result.output.length).toBeLessThan(257 * 1024);
  });

  it("does not combine partial stdout and stderr lines", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = streamGatewayStart("openshell gateway start", {
      NEMOCLAW_GATEWAY_START_TIMEOUT: "60",
    });

    child.stdout.emit("data", Buffer.from("stdout-part"));
    child.stderr.emit("data", Buffer.from("stderr-line\n"));
    child.stdout.emit("data", Buffer.from("-end\n"));
    child.emit("close", 0);

    const result = await resultPromise;
    expect(result.output.split("\n")).toEqual(["stderr-line", "stdout-part-end"]);
  });
});
