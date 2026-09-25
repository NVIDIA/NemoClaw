// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

vi.mock("./client", () => ({ captureOpenshellCommandAsyncResult: vi.fn() }));

import {
  captured,
  capturedForwardList,
  createHarness,
  createLinuxProcFixture,
  errors,
  forward,
  missingCommand,
  noActiveForwards,
  runtimeSelection,
  type HostProbe,
  type InspectListener,
  type SignalProcess,
} from "./forward-cli-test-fixture";
import { createCliOpenShellForwardAdapter } from "./forward-cli";

it("recognizes the reviewed pre-endpoint Linux command shape", async () => {
  const fixture = createLinuxProcFixture({ pid: 4_312 });
  const command = [
    fixture.executable,
    "--gateway nemoclaw --workspace default forward service demo",
    "--target-port 18789 --target-host 127.0.0.1 --local 127.0.0.1:18789",
  ].join(" ");
  const hostProbe = vi.fn<HostProbe>(async (executable) =>
    executable === "/usr/bin/lsof" ? missingCommand() : captured(0, `${command}\n`),
  );
  const signalProcess = vi.fn<SignalProcess>();
  const adapter = createCliOpenShellForwardAdapter({
    environment: {},
    executable: fixture.executable,
    gatewayEndpoint: forward.gatewayEndpoint,
    hostProbe,
    platform: "linux",
    probePort: async () => ({ state: "unbound" }),
    procRoot: fixture.procRoot,
    run: async () => capturedForwardList(noActiveForwards),
    runtimeSelection,
    signalProcess,
  });

  try {
    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "foreign", forward },
    ]);
    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({ state: "retired", forward });
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(4_312, "SIGKILL");
  } finally {
    fixture.remove();
  }
});

it("does not signal a pre-endpoint forward whose PID changes", async () => {
  const signalProcess = vi.fn<SignalProcess>();
  const inspect = vi
    .fn<InspectListener>()
    .mockResolvedValueOnce({ state: "pre_endpoint", pid: 4_312 })
    .mockResolvedValueOnce({ state: "pre_endpoint", pid: 9_876 });
  const { adapter } = createHarness({ inspect, signalProcess });

  await expect(
    adapter.retireLegacyForward({ forward, authorize: async () => {} }),
  ).resolves.toEqual({ state: "failed", forward, effect: "none", error: errors.ownership });
  expect(signalProcess).not.toHaveBeenCalled();
});
