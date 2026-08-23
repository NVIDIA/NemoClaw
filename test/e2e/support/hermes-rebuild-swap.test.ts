// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import {
  HERMES_REBUILD_SWAP_BYTES,
  needsHermesRebuildSwap,
  parseActiveSwapBytes,
} from "../fixtures/hermes-rebuild-swap.ts";
import { prepareHermesRebuildSwap } from "../live/rebuild-hermes-swap.ts";

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, signal: null, stderr, stdout };
}

describe("Hermes rebuild swap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds active swap sizes reported by swapon", () => {
    expect(parseActiveSwapBytes("17179869184\n17179869184\n")).toBe(HERMES_REBUILD_SWAP_BYTES);
  });

  it("adds active swap sizes from GitHub Actions runner rows", () => {
    const output = [
      "/swapfile file 3221221376 0 -2",
      "/mnt/nemoclaw-hermes-rebuild.swap file 34359734272 0 -3",
    ].join("\n");

    expect(parseActiveSwapBytes(output)).toBe(37_580_955_648);
  });

  it("ignores unrelated five-field output", () => {
    const activeSwapBytes = parseActiveSwapBytes("notice ignored 34359738368 text text");

    expect(activeSwapBytes).toBe(0);
    expect(needsHermesRebuildSwap({ activeSwapBytes, githubActions: true })).toBe(true);
  });

  it("provisions swap only on GitHub Actions runners below the rebuild floor", () => {
    expect(needsHermesRebuildSwap({ activeSwapBytes: 0, githubActions: true })).toBe(true);
    expect(
      needsHermesRebuildSwap({
        activeSwapBytes: HERMES_REBUILD_SWAP_BYTES,
        githubActions: true,
      }),
    ).toBe(false);
    expect(needsHermesRebuildSwap({ activeSwapBytes: 0, githubActions: false })).toBe(false);
  });

  it("registers cleanup before verifying and removes the created swap", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    let cleanupAction: (() => Promise<void> | void) | undefined;
    const trackDisposable = vi.fn((name: string, action: () => Promise<void> | void) => {
      expect(name).toBe("remove Hermes rebuild swap");
      cleanupAction = action;
    });
    const command = vi
      .fn<(_commandName: string, _args?: string[]) => Promise<ReturnType<typeof result>>>()
      .mockResolvedValueOnce(result(0, "0\n"))
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async () => {
        expect(trackDisposable).toHaveBeenCalledOnce();
        return result(0, `${String(HERMES_REBUILD_SWAP_BYTES)}\n`);
      })
      .mockResolvedValueOnce(result());

    await prepareHermesRebuildSwap(
      { command } as unknown as HostCliClient,
      { trackDisposable },
    );

    expect(command.mock.calls.map(([commandName]) => commandName)).toEqual([
      "swapon",
      "sudo",
      "swapon",
    ]);
    expect(cleanupAction).toEqual(expect.any(Function));
    await cleanupAction?.();
    expect(command.mock.calls.map(([commandName]) => commandName)).toEqual([
      "swapon",
      "sudo",
      "swapon",
      "sudo",
    ]);
  });

  it("propagates cleanup failure", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const responses = [
      result(0, "0\n"),
      result(),
      result(0, `${String(HERMES_REBUILD_SWAP_BYTES)}\n`),
      result(1, "", "swap remains active"),
    ];
    let cleanupAction: (() => Promise<void> | void) | undefined;
    const command = vi.fn(
      async (_commandName: string, _args: string[] = []) => responses.shift() ?? result(1),
    );

    await prepareHermesRebuildSwap(
      { command } as unknown as HostCliClient,
      {
        trackDisposable: (_name, action) => {
          cleanupAction = action;
        },
      },
    );

    await expect(cleanupAction?.()).rejects.toThrow("remove Hermes rebuild swap failed");
  });

  it("removes a new swap path when provisioning fails after allocation", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-swap-test-"));
    const binDirectory = path.join(directory, "bin");
    const swapPath = path.join(directory, "rebuild.swap");
    fs.mkdirSync(binDirectory);
    fs.writeFileSync(
      path.join(binDirectory, "fallocate"),
      '#!/usr/bin/env bash\nset -euo pipefail\n: > "$3"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDirectory, "mkswap"), "#!/usr/bin/env bash\nexit 42\n", {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(binDirectory, "swapoff"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    const trackDisposable = vi.fn();
    const command = vi
      .fn()
      .mockResolvedValueOnce(result(0, "0\n"))
      .mockImplementationOnce(async (_commandName: string, args: string[]) => {
        const execution = spawnSync(
          "bash",
          ["-c", args[2], args[3], swapPath, args[5]],
          {
            encoding: "utf8",
            env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ""}` },
          },
        );
        expect(execution.status).toBe(42);
        expect(fs.existsSync(swapPath)).toBe(false);
        return result(execution.status ?? 1, execution.stdout, execution.stderr);
      });

    try {
      await expect(
        prepareHermesRebuildSwap(
          { command } as unknown as HostCliClient,
          { trackDisposable },
        ),
      ).rejects.toThrow("provision swap for Hermes rebuild failed");
      expect(trackDisposable).not.toHaveBeenCalled();
      expect(fs.existsSync(swapPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
