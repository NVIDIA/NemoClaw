// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./create-stream";
import { dockerEnv, FakeChild } from "./create-stream-test-fixtures";

describe("sandbox-create-stream argv boundary", () => {
  it("keeps the legacy string-command overload shell compatible", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = streamSandboxCreate("echo create", dockerEnv, {
      spawnImpl,
      logLine: vi.fn(),
    });

    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ status: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "echo create"],
      expect.not.objectContaining({ shell: true }),
    );
  });

  it("spawns argv directly without shell wrapping", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = streamSandboxCreate(
      "openshell",
      ["sandbox", "create", "alpha; rm -rf /", "--", "nemoclaw-start"],
      dockerEnv,
      {
        spawnImpl,
        logLine: vi.fn(),
      },
    );

    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ status: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "create", "alpha; rm -rf /", "--", "nemoclaw-start"],
      expect.not.objectContaining({ shell: true }),
    );
  });

  it("inherits process env when argv callers omit env", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = streamSandboxCreate("openshell", ["sandbox", "create"], undefined, {
      spawnImpl,
      logLine: vi.fn(),
    });

    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ status: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "create"],
      expect.objectContaining({ env: process.env }),
    );
  });

  it("uses the exact schema-owned build context without changing argv dispatch (#9203)", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = streamSandboxCreate(
      "openshell",
      ["sandbox", "create", "--from", "/private/context/Dockerfile"],
      dockerEnv,
      { cwd: "/private/context", spawnImpl, logLine: vi.fn() },
    );

    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ status: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "create", "--from", "/private/context/Dockerfile"],
      expect.objectContaining({ cwd: "/private/context" }),
    );
  });
});
