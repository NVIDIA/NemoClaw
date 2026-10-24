// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

it.each([null, "https://127.0.0.1:19080"])(
  "refuses wildcard migration when the process gateway endpoint is %s",
  async (endpoint) => {
    const fixture = createLinuxProcFixture({ pid: 4_312 });
    const wildcard = { ...forward, localHost: "0.0.0.0" as const };
    const tcpPath = join(fixture.procRoot, "net", "tcp");
    writeFileSync(tcpPath, readFileSync(tcpPath, "utf8").replace("0100007F:4965", "00000000:4965"));
    const command = [
      fixture.executable,
      `--gateway nemoclaw${endpoint === null ? "" : ` --gateway-endpoint ${endpoint}`} --workspace default`,
      "forward service demo --target-port 18789 --target-host 127.0.0.1 --local 0.0.0.0:18789",
    ].join(" ");
    const signalProcess = vi.fn<SignalProcess>();
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable: fixture.executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe: async (executable) =>
        executable === "/usr/bin/lsof" ? missingCommand() : captured(0, `${command}\n`),
      platform: "linux",
      probePort: async () => ({ state: "unbound" }),
      procRoot: fixture.procRoot,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
      signalProcess,
    });
    try {
      await expect(
        adapter.retireLegacyForward({
          forward: wildcard,
          migrateToLoopback: true,
          authorize: async () => {},
        }),
      ).resolves.toMatchObject({ state: "refused", observation: { state: "foreign" } });
      expect(signalProcess).not.toHaveBeenCalled();
    } finally {
      fixture.remove();
    }
  },
);

it("retires an exact owned wildcard forward only for loopback migration", async () => {
  const wildcard = { ...forward, localHost: "0.0.0.0" as const };
  const inspect = vi.fn<InspectListener>(async () => ({ state: "owned", pid: 4_312 }));
  const signalProcess = vi.fn<SignalProcess>();
  const { adapter } = createHarness({ inspect, signalProcess });
  await expect(
    adapter.retireLegacyForward({ forward: wildcard, authorize: async () => {} }),
  ).resolves.toMatchObject({ state: "not_needed" });
  await expect(
    adapter.retireLegacyForward({
      forward: wildcard,
      migrateToLoopback: true,
      authorize: async () => {},
    }),
  ).resolves.toEqual({ state: "retired", forward: wildcard });
  expect(signalProcess).toHaveBeenCalledExactlyOnceWith(4_312, "SIGKILL");
});

it.each(["changed PID", "foreign", "indeterminate"] as const)(
  "preserves a wildcard listener with %s at migration revalidation",
  async (change) => {
    const wildcard = { ...forward, localHost: "0.0.0.0" as const };
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "owned", pid: 4_312 })
      .mockResolvedValue(
        change === "changed PID"
          ? { state: "owned", pid: 9_876 }
          : change === "foreign"
            ? { state: "foreign", pids: [9_876] }
            : { state: "indeterminate" },
      );
    const signalProcess = vi.fn<SignalProcess>();
    const { adapter } = createHarness({ inspect, signalProcess });
    const result = await adapter.retireLegacyForward({
      forward: wildcard,
      migrateToLoopback: true,
      authorize: async () => {},
    });
    expect(["failed", "refused"]).toContain(result.state);
    expect(signalProcess).not.toHaveBeenCalled();
  },
);

it("does not migrate an already loopback direct forward", async () => {
  const signalProcess = vi.fn<SignalProcess>();
  const { adapter } = createHarness({ signalProcess });
  await expect(
    adapter.retireLegacyForward({ forward, migrateToLoopback: true, authorize: async () => {} }),
  ).resolves.toMatchObject({ state: "failed", effect: "none", error: errors.validation });
  expect(signalProcess).not.toHaveBeenCalled();
});

it("preserves a wildcard forward when authority changes before retirement", async () => {
  const signalProcess = vi.fn<SignalProcess>();
  const { adapter } = createHarness({
    signalProcess,
    inspect: async () => ({ state: "owned", pid: 4_321 }),
  });
  await expect(
    adapter.retireLegacyForward({
      forward: { ...forward, localHost: "0.0.0.0" },
      migrateToLoopback: true,
      authorize: async () => {
        throw new Error("sandbox replaced");
      },
    }),
  ).resolves.toMatchObject({ state: "failed", effect: "none", error: errors.authority });
  expect(signalProcess).not.toHaveBeenCalled();
});

it("reports an unreleased wildcard port after migration retirement", async () => {
  const signalProcess = vi.fn<SignalProcess>();
  const { adapter } = createHarness({
    signalProcess,
    inspect: async () => ({ state: "owned", pid: 4_321 }),
    probePort: async () => ({ state: "bound" }),
  });
  await expect(
    adapter.retireLegacyForward({
      forward: { ...forward, localHost: "0.0.0.0" },
      migrateToLoopback: true,
      authorize: async () => {},
    }),
  ).resolves.toMatchObject({
    state: "release_unproved",
    effect: "possible",
    error: errors.cleanup,
  });
  expect(signalProcess).toHaveBeenCalledExactlyOnceWith(4_321, "SIGKILL");
});
