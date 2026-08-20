// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { withLocalBuildHeartbeat } from "./local-build-heartbeat";

function heartbeatChild() {
  return {
    child: {
      kill: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    } as unknown as ChildProcess,
    spawnImpl: vi.fn(),
  };
}

describe("sandbox base-image Docker operation heartbeat", () => {
  it("runs independently of the synchronous build and stops afterward", () => {
    const fixture = heartbeatChild();
    fixture.spawnImpl.mockReturnValue(fixture.child);

    expect(
      withLocalBuildHeartbeat(() => "built", {
        intervalMs: 25_000,
        nodeExecutable: "/node",
        parentPid: 42,
        spawnImpl: fixture.spawnImpl as unknown as typeof spawn,
      }),
    ).toBe("built");

    expect(fixture.spawnImpl).toHaveBeenCalledOnce();
    const [executable, args, options] = fixture.spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(executable).toBe("/node");
    expect(args.slice(0, 2)).toEqual(["-e", expect.any(String)]);
    expect(args.slice(2)).toEqual(["25000", "42", "build"]);
    expect(options).toEqual({ env: {}, stdio: ["ignore", "inherit", "inherit"] });
    expect(fixture.child.unref).toHaveBeenCalledOnce();
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("emits pull activity from the spawned heartbeat and stops afterward", async () => {
    let child: ChildProcess | undefined;
    let output = "";
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;
    const spawnImpl = vi.fn(
      (executable: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
        child = spawn(executable, args, {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        killSpy = vi.spyOn(child, "kill");
        return child;
      },
    );

    expect(
      withLocalBuildHeartbeat(
        () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
          return "pulled";
        },
        {
          activity: "pull",
          intervalMs: 10,
          spawnImpl: spawnImpl as unknown as typeof spawn,
        },
      ),
    ).toBe("pulled");

    expect(child).toBeDefined();
    await once(child as ChildProcess, "close");
    expect(output).toContain("Still working on sandbox base image pull");
    expect(output).not.toContain("Still working on sandbox base image build");
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops the heartbeat when the synchronous build throws", () => {
    const fixture = heartbeatChild();
    fixture.spawnImpl.mockReturnValue(fixture.child);

    expect(() =>
      withLocalBuildHeartbeat(
        () => {
          throw new Error("build failed");
        },
        { spawnImpl: fixture.spawnImpl as unknown as typeof spawn },
      ),
    ).toThrow("build failed");
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps the build authoritative when heartbeat startup fails", () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("heartbeat unavailable");
    });

    expect(
      withLocalBuildHeartbeat(() => "built", {
        spawnImpl: spawnImpl as unknown as typeof spawn,
      }),
    ).toBe("built");
  });
});
