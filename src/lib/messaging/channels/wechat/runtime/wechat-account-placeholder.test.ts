// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { refreshWechatAccountPlaceholder } from "./wechat-account-placeholder";

function metadata(kind: "file" | "symlink"): Pick<fs.Stats, "isFile" | "isSymbolicLink"> {
  return {
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function spawnResult(
  status: number | null,
  error?: Error,
): { error?: Error; status: number | null } {
  return { error, status };
}

describe("OpenClaw WeChat account placeholder preload", () => {
  it("does nothing when OpenClaw configuration is absent", () => {
    const spawn = vi.fn();

    refreshWechatAccountPlaceholder({
      existsSync: () => false,
      lstatSync: vi.fn(),
      spawnSync: spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a symlinked refresher", () => {
    const spawn = vi.fn();

    expect(() =>
      refreshWechatAccountPlaceholder({
        existsSync: () => true,
        lstatSync: () => metadata("symlink"),
        spawnSync: spawn,
      }),
    ).toThrow(/\[SECURITY\].*refresher/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the isolated descriptor-safe helper immediately in the preload", () => {
    const spawn = vi.fn(() => spawnResult(0));

    refreshWechatAccountPlaceholder({
      existsSync: () => true,
      lstatSync: () => metadata("file"),
      spawnSync: spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/python3",
      [
        "-I",
        "/usr/local/lib/nemoclaw/refresh-openclaw-wechat-placeholder.py",
        "/sandbox/.openclaw/openclaw.json",
      ],
      { env: process.env, stdio: "inherit", timeout: 30_000 },
    );
  });

  it("fails closed without exposing helper diagnostics", () => {
    expect(() =>
      refreshWechatAccountPlaceholder({
        existsSync: () => true,
        lstatSync: () => metadata("file"),
        spawnSync: () => spawnResult(null, new Error("secret helper detail")),
      }),
    ).toThrow("[SECURITY] WeChat account placeholder refresh failed.");
  });
});
