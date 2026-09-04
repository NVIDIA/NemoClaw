// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertFirstRepairRun,
  type RepairLifecycle,
  runRepairLifecycle,
} from "../../../tools/pr-review-advisor-repair/resolve.mts";

describe("PR Review Advisor repair owned lifecycle", () => {
  it("cannot start Pi again when GitHub reruns failed jobs (#10791)", () => {
    expect(() => assertFirstRepairRun({ GITHUB_RUN_ATTEMPT: "2" })).toThrow(
      "repair generation is disabled on workflow reruns",
    );
  });

  it("stops the owned gateway and removes the sandbox after success (#10791)", async () => {
    const calls: string[] = [];
    const lifecycle: RepairLifecycle = {
      startInference: () => {
        calls.push("start");
        return {
          configure: Promise.resolve().then(() => void calls.push("configure")),
          stop: async () => void calls.push("stop"),
        };
      },
      create: () => void calls.push("create"),
      run: () => void calls.push("run"),
      download: () => void calls.push("download"),
      exportPatch: () => void calls.push("export"),
      remove: () => void calls.push("remove"),
    };

    await runRepairLifecycle({}, lifecycle);

    expect(calls).toEqual([
      "start",
      "configure",
      "create",
      "run",
      "download",
      "export",
      "remove",
      "stop",
    ]);
  });

  it("stops the gateway without deleting an unclaimed sandbox after configuration fails (#10791)", async () => {
    const calls: string[] = [];
    const failure = new Error("provider configuration failed");
    const lifecycle: RepairLifecycle = {
      startInference: () => ({
        configure: Promise.reject(failure),
        stop: async () => void calls.push("stop"),
      }),
      create: () => void calls.push("create"),
      run: () => void calls.push("run"),
      download: () => void calls.push("download"),
      exportPatch: () => void calls.push("export"),
      remove: () => void calls.push("remove"),
    };

    await expect(runRepairLifecycle({}, lifecycle)).rejects.toBe(failure);
    expect(calls).toEqual(["stop"]);
  });

  it("preserves the repair failure when sandbox and gateway cleanup also fail (#10791)", async () => {
    const calls: string[] = [];
    const primary = new Error("repair turn failed");
    const lifecycle: RepairLifecycle = {
      startInference: () => ({
        configure: Promise.resolve(),
        stop: async () => {
          calls.push("stop");
          throw new Error("gateway stop failed");
        },
      }),
      create: () => void calls.push("create"),
      run: () => {
        calls.push("run");
        throw primary;
      },
      download: () => void calls.push("download"),
      exportPatch: () => void calls.push("export"),
      remove: () => {
        calls.push("remove");
        throw new Error("sandbox delete failed");
      },
    };

    const failure = await runRepairLifecycle({}, lifecycle).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).cause).toBe(primary);
    expect((failure as Error).message).toBe(
      "repair turn failed; repair lifecycle cleanup also failed: sandbox cleanup: sandbox delete failed; gateway cleanup: gateway stop failed",
    );
    expect(calls).toEqual(["create", "run", "remove", "stop"]);
  });
});
