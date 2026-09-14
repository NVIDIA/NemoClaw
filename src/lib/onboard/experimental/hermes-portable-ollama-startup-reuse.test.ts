// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { withHermesPortableStartupOperation } from "./hermes-portable-startup-operation";
import { recoverHermesPortableOllamaInference } from "./hermes-portable-ollama-inference";
import { createHarness } from "./hermes-portable-ollama-recovery.test-fixture";

describe("Portable inference startup reuse", () => {
  let stateDir: string;
  let now: number;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-inference-reuse-"));
    now = 0;
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  function setup(intent: "connect-probe-only" | "connect-interactive" = "connect-probe-only") {
    const harness = createHarness(true, true);
    harness.input.stateDir = stateDir;
    harness.input.env = {
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE: "1",
    };
    const inspectReadinessRuntime = vi.fn(() => ({
      kind: "running-current" as "running-current" | "stopped",
      assertCurrent: vi.fn(),
    }));
    const dependency = { release: vi.fn(), rollback: vi.fn() };
    const input = {
      ...harness.input,
      intent,
      prepareProbeDependency: vi.fn(async () => dependency),
    };
    const overrides = { ...harness.overrides, inspectReadinessRuntime };
    const recover = () => recoverHermesPortableOllamaInference(input, overrides as never);
    const run = () =>
      withMcpLifecycleLock(
        "alpha",
        () =>
          withHermesPortableStartupOperation(
            "alpha",
            path.join(stateDir, "state"),
            recover,
            input.env,
            () => now,
          ),
        { stateDir: path.join(stateDir, "state") },
      );
    return { harness, input, overrides, dependency, recover, run };
  }

  it("verifies a healthy exact runtime without preparing mutating recovery (#11574)", async () => {
    const h = setup();
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.inspectReadinessRuntime).toHaveBeenCalledTimes(2);
    expect(h.input.verifyRoute).toHaveBeenCalledOnce();
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).toHaveBeenCalledOnce();
    expect(h.dependency.rollback).not.toHaveBeenCalled();
  });

  it("uses full recovery authority for interactive connect when startup reuse is enabled", async () => {
    const h = setup("connect-interactive");
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.inspectReadinessRuntime).not.toHaveBeenCalled();
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
    expect(h.input.verifyRoute).toHaveBeenCalledOnce();
    expect(h.dependency.release).toHaveBeenCalledOnce();
    expect(h.dependency.rollback).not.toHaveBeenCalled();
  });

  it("reinspects through the original read-only authority after the async boundary (#11574)", async () => {
    const h = setup();
    const reinspect = vi.fn(() => ({ kind: "running-current" as const, assertCurrent: vi.fn() }));
    h.overrides.inspectReadinessRuntime.mockReturnValueOnce({
      kind: "running-current",
      assertCurrent: vi.fn(),
      reinspect,
    } as never);
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.inspectReadinessRuntime).toHaveBeenCalledOnce();
    expect(reinspect).toHaveBeenCalledOnce();
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
  });

  it("falls back after stopped (#11574)", async () => {
    const h = setup();
    h.overrides.inspectReadinessRuntime.mockReturnValueOnce({
      kind: "stopped",
      assertCurrent: vi.fn(),
    });
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });

  it("falls back after unreachable route (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockRejectedValueOnce(new Error("unreachable"));
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });

  it("falls back after expired scope (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      now = 60_000;
      return h.input.entry;
    });
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });

  it.each(["0", undefined])("keeps reuse=%s on full recovery (#11574)", async (gate) => {
    const h = setup();
    Object.assign(h.input.env, { NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE: gate });
    await expect(h.run()).resolves.toBe("reused");
    expect(h.overrides.inspectReadinessRuntime).not.toHaveBeenCalled();
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });

  it("propagates rollback failure without entering another recovery transaction (#11574)", async () => {
    const h = setup();
    h.input.prepareProbeDependency.mockImplementationOnce(async () => {
      h.input.readRegistry.mockReturnValue({ ...h.input.entry, model: "changed" });
      return h.dependency;
    });
    h.dependency.rollback.mockImplementation(() => {
      throw new Error("rollback unproved");
    });
    await expect(h.run()).rejects.toThrow("rollback unproved");
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("keeps calls outside the lifecycle operation on full recovery (#11574)", async () => {
    const h = setup();
    await expect(h.recover()).resolves.toBe("reused");
    expect(h.overrides.inspectReadinessRuntime).not.toHaveBeenCalled();
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });

  it("rejects receipt drift instead of accepting health (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      h.overrides.readReceipt.mockReturnValue({ receipt: { phase: "stopped" }, successor: {} });
      return h.input.entry;
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rejects registry drift instead of accepting health (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      h.input.readRegistry.mockReturnValue({ ...h.input.entry, model: "changed" });
      return h.input.entry;
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rejects operating drift instead of accepting health (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      h.overrides.qualifyOperatingAuthority.mock.results[0].value.assertCurrent.mockImplementation(
        () => {
          throw new Error("operating authority changed");
        },
      );
      return h.input.entry;
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rejects route entry drift instead of accepting health (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      return { ...h.input.entry, model: "changed" };
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rejects environment drift instead of accepting health (#11574)", async () => {
    const h = setup();
    h.input.verifyRoute.mockImplementationOnce(async () => {
      Object.assign(h.input.env, { PATH: "/changed" });
      return h.input.entry;
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rolls back a prepared dependency when its boundary changes authority (#11574)", async () => {
    const h = setup();
    h.input.prepareProbeDependency.mockImplementationOnce(async () => {
      h.input.readRegistry.mockReturnValue({ ...h.input.entry, model: "changed" });
      return h.dependency;
    });
    await expect(h.run()).rejects.toThrow(/changed/);
    expect(h.dependency.rollback).toHaveBeenCalledOnce();
    expect(h.dependency.release).not.toHaveBeenCalled();
  });

  it("rolls back and uses full recovery if the runtime stops after route verification (#11574)", async () => {
    const h = setup();
    h.overrides.inspectReadinessRuntime
      .mockReturnValueOnce({ kind: "running-current", assertCurrent: vi.fn() })
      .mockReturnValueOnce({ kind: "stopped", assertCurrent: vi.fn() });
    await expect(h.run()).resolves.toBe("reused");
    expect(h.dependency.rollback).toHaveBeenCalledOnce();
    expect(h.overrides.prepareRecoveryEntry).toHaveBeenCalledOnce();
  });
});
