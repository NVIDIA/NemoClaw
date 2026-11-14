// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawPairingFixture } from "../../../../../test/helpers/openclaw-pairing-fixture";
import {
  observeOpenClawPairingQualification,
  OpenClawPairingObservationRetryableError,
  OpenClawPairingQualificationError,
} from "./openclaw-pairing-qualification";

const pythonAvailable = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function observe(spawn: typeof spawnSync, stateDirectory = "/sandbox/.openclaw") {
  return observeOpenClawPairingQualification("alpha", "nemoclaw", "2026.10.5", stateDirectory, {
    getOpenshellBinary: () => "openshell",
    spawnSync: spawn,
  });
}

describe("OpenClaw pairing observation races", () => {
  it.skipIf(!pythonAvailable)("reobserves canonical state after a transient missing entry", () => {
    const fixture = createOpenClawPairingFixture();
    roots.push(fixture.root);
    const pending = path.join(fixture.stateDirectory, "devices", "pending.json");
    const original = fs.readFileSync(pending);
    fs.rmSync(pending);
    const statuses: Array<number | null> = [];
    const spawn = vi.fn(
      (_binary: string, _args: readonly string[], options: Parameters<typeof spawnSync>[2]) => {
        const result = spawnSync("sh", ["-s"], options);
        statuses.push(result.status);
        return result;
      },
    );
    spawn.mockImplementationOnce(
      (_binary: string, _args: readonly string[], options: Parameters<typeof spawnSync>[2]) => {
        const result = spawnSync("sh", ["-s"], options);
        statuses.push(result.status);
        fs.writeFileSync(pending, original, { mode: 0o660 });
        return result;
      },
    );

    expect(observe(spawn as never, fixture.stateDirectory)).toMatchObject({
      kind: "openclaw-pairing",
    });
    expect(statuses).toEqual([3, 0]);
  });

  it("shares the original deadline across transient observations", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    const spawn = vi.fn(
      (_binary: string, _args: readonly string[], options: Parameters<typeof spawnSync>[2]) => {
        timeouts.push(options?.timeout ?? 0);
        now = timeouts.length === 1 ? 2_500 : 3_001;
        return { status: 3, signal: null, stdout: "", stderr: "" };
      },
    );

    expect(() => observe(spawn as never)).toThrow(OpenClawPairingObservationRetryableError);
    expect(timeouts).toEqual([3_000, 500]);
  });

  it("caps persistent state changes at three observations", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const spawn = vi.fn(() => ({ status: 3, signal: null, stdout: "", stderr: "" }));
    expect(() => observe(spawn as never)).toThrow(OpenClawPairingObservationRetryableError);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("does not retry rejected client authorization", () => {
    const spawn = vi.fn(() => ({
      status: 1,
      signal: null,
      stdout: "__NEMOCLAW_OPENCLAW_PAIRING_FAILURE__=client-auth\n",
      stderr: "",
    }));
    expect(() => observe(spawn as never)).toThrow(OpenClawPairingQualificationError);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
