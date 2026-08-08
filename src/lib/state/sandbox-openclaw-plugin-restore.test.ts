// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { discoverFreshOpenClawPluginExtensionDirs } from "./openclaw-plugin-restore";

const OPENCLAW_DIR = "/sandbox/.openclaw";
const MAX_PLUGIN_REGISTRY_BYTES = 1024 * 1024;

function spawnResult(
  status: number | null,
  stdout: Buffer,
  options: { error?: Error; signal?: NodeJS.Signals | null } = {},
): ReturnType<typeof spawnSync> {
  return {
    error: options.error,
    status,
    signal: options.signal ?? null,
    output: [null, stdout, Buffer.alloc(0)],
    pid: 1234,
    stdout,
    stderr: Buffer.alloc(0),
  } as ReturnType<typeof spawnSync>;
}

function discover() {
  return discoverFreshOpenClawPluginExtensionDirs(
    {
      getSshConfig: () => "unused",
      sshArgs: (configFile, sandboxName) => ["-F", configFile, `openshell-${sandboxName}`],
    },
    "/tmp/ssh-config",
    "sandbox-one",
    OPENCLAW_DIR,
  );
}

describe("fresh OpenClaw plugin registry reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an oversized SQLite registry response before JSON.parse", () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    vi.mocked(spawnSync).mockReturnValue(spawnResult(0, Buffer.alloc(5 * 1024 * 1024, " ")));

    expect(discover()).toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ maxBuffer: MAX_PLUGIN_REGISTRY_BYTES, timeout: 30000 }),
    );
  });

  it("classifies a real maxBuffer ENOBUFS result before parsing truncated output", () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    const error = Object.assign(new Error("spawnSync ssh ENOBUFS"), { code: "ENOBUFS" });
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult(null, Buffer.alloc(MAX_PLUGIN_REGISTRY_BYTES + 8192, " "), {
        error,
        signal: "SIGTERM",
      }),
    );

    expect(discover()).toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("rejects an oversized legacy registry response after the status-2 fallback", () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    vi.mocked(spawnSync)
      .mockReturnValueOnce(spawnResult(2, Buffer.alloc(0)))
      .mockReturnValueOnce(spawnResult(0, Buffer.alloc(5 * 1024 * 1024, " ")));

    expect(discover()).toEqual({
      ok: false,
      error: "fresh OpenClaw plugin install registry response too large",
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ maxBuffer: MAX_PLUGIN_REGISTRY_BYTES, timeout: 30000 }),
      );
    }
  });

  it.each([10, 11])("does not use the legacy fallback for SQLite status %i", (status) => {
    vi.mocked(spawnSync).mockReturnValue(spawnResult(status, Buffer.alloc(0)));

    expect(discover()).toEqual({
      ok: false,
      error: "could not read fresh OpenClaw plugin install registry",
    });
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});
