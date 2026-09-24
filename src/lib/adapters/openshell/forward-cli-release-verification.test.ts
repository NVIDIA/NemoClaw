// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createHarness,
  errors,
  forward,
  otherForward,
  throwSupersededWhen,
} from "./forward-cli-test-fixture";

describe("CLI OpenShell forward release verification", () => {
  it("reports release only when every requested port is unbound", async () => {
    const { adapter, probePort, run, spawn, terminate } = createHarness();

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward, otherForward] }),
    ).resolves.toEqual({ state: "released" });
    expect(probePort).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("reports a port that remains bound", async () => {
    const { adapter } = createHarness({
      probePort: async (identity) =>
        identity.port === forward.port ? { state: "bound" } : { state: "unbound" },
    });

    await expect(
      adapter.verifyForwardRelease({
        forwards: [forward, otherForward],
        timeoutMs: 2,
      }),
    ).resolves.toEqual({ state: "bound", forwards: [forward] });
  });

  it("reports indeterminate release without treating the port as free", async () => {
    const { adapter } = createHarness({
      probePort: async (identity) =>
        identity.port === forward.port
          ? { state: "indeterminate", error: errors.transport }
          : { state: "unbound" },
    });

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward, otherForward] }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward],
      error: errors.transport,
    });
  });

  it("reports both bound and indeterminate ports as unreleased", async () => {
    const { adapter, probePort, sleep } = createHarness({
      probePort: async (identity) =>
        identity.port === forward.port
          ? { state: "bound" }
          : { state: "indeterminate", error: errors.transport },
    });

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward, otherForward] }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward, otherForward],
      error: errors.transport,
    });
    expect(probePort).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not probe release when its initial currentness fence is stale", async () => {
    const assertCurrent = vi.fn(async () => {
      throw new Error("superseded generation");
    });
    const { adapter, probePort } = createHarness();

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward, otherForward], assertCurrent }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward, otherForward],
      error: errors.authority,
    });
    expect(probePort).not.toHaveBeenCalled();
  });

  it("fences a completed release probe before trusting its result", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter, probePort } = createHarness({
      probePort: async () => {
        current = false;
        return { state: "unbound" };
      },
    });

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward], assertCurrent }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward],
      error: errors.authority,
    });
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, 5_000);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("fences each bounded release polling attempt", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter, probePort } = createHarness({
      probePort: async () => ({ state: "bound" }),
      sleep: async () => {
        current = false;
      },
    });

    await expect(
      adapter.verifyForwardRelease({ forwards: [forward], assertCurrent }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward],
      error: errors.authority,
    });
    expect(probePort).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });
});
