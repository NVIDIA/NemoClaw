// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ captureOpenshellCommandAsyncResult: vi.fn() }));

import {
  captured,
  capturedForwardList,
  createHarness,
  createLinuxProcFixture,
  errors,
  executable,
  forward,
  invokeWhen,
  legacyForwardList,
  listHeader,
  missingCommand,
  noActiveForwards,
  runtimeSelection,
  throwSupersededWhen,
  type ForwardChild,
  type HostProbe,
  type InspectLegacyListener,
  type InspectListener,
  type ProbePort,
  type RunCommand,
  type SignalProcess,
} from "./forward-cli-test-fixture";
import {
  buildCliOpenShellForwardListArgs,
  buildCliOpenShellForwardServiceArgs,
  buildCliOpenShellLegacyForwardStopArgs,
  createCliOpenShellForwardAdapter,
} from "./forward-cli";

describe("CLI OpenShell forward observations", () => {
  it.each([
    {
      state: "owned",
      output: noActiveForwards,
      inspection: { state: "owned", pid: 4_321 } as const,
      expected: { state: "owned", forward },
    },
    {
      state: "absent",
      output: noActiveForwards,
      inspection: { state: "unbound" } as const,
      expected: { state: "absent", forward },
    },
    {
      state: "foreign",
      output: noActiveForwards,
      inspection: { state: "foreign", pids: [9_876] } as const,
      expected: { state: "foreign", forward },
    },
    {
      state: "indeterminate",
      output: noActiveForwards,
      inspection: { state: "indeterminate" } as const,
      expected: { state: "indeterminate", forward, error: errors.ownership },
    },
  ])("returns the $state state from matching registry and listener evidence", async (testCase) => {
    const inspect = vi.fn<InspectListener>(async () => testCase.inspection);
    const { adapter } = createHarness({
      inspect,
      run: async () => capturedForwardList(testCase.output),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      testCase.expected,
    ]);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(forward, undefined, 15_000);
  });

  it.each([
    [4_321, { state: "owned", forward }],
    [9_876, { state: "foreign", forward }],
  ] as const)(
    "binds forward ownership to expected listener PID %s",
    async (expectedPid, expected) => {
      const inspect = vi.fn<InspectListener>(async (_forward, listenerPid) =>
        listenerPid === 4_321
          ? { state: "owned", pid: 4_321 }
          : { state: "foreign", pids: [4_321] },
      );
      const { adapter } = createHarness({
        inspect,
        run: async () => capturedForwardList(noActiveForwards),
      });

      await expect(
        adapter.observeForwards({
          forwards: [forward],
          expectedListenerPidsByPort: new Map([[forward.port, expectedPid]]),
        }),
      ).resolves.toEqual([expected]);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(forward, expectedPid, 15_000);
    },
  );

  it("returns stale only when the legacy inspector owns the listed PID", async () => {
    const { adapter, inspect, inspectLegacy } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "stale", forward },
    ]);
    expect(inspectLegacy).toHaveBeenCalledExactlyOnceWith(forward, 4_312, 15_000);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    {
      proof: "proves the listed PID",
      inspection: { state: "owned", pid: 4_312 } as const,
      expected: { state: "foreign", forward },
    },
    {
      proof: "cannot prove the listed PID",
      inspection: { state: "not_owned" } as const,
      expected: { state: "indeterminate", forward, error: errors.ownership },
    },
    {
      proof: "has indeterminate PID evidence",
      inspection: { state: "indeterminate" } as const,
      expected: { state: "indeterminate", forward, error: errors.ownership },
    },
  ])("classifies a conflicting registry row only after it $proof", async (testCase) => {
    const conflictingForwardList = [listHeader, "other 127.0.0.1 18789 4312 running"].join("\n");
    const { adapter, inspect, inspectLegacy } = createHarness({
      inspectLegacy: async () => testCase.inspection,
      run: async () => captured(0, conflictingForwardList),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      testCase.expected,
    ]);
    expect(inspectLegacy).toHaveBeenCalledExactlyOnceWith(forward, 4_312, 15_000);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed before reading registry state when authority is not current", async () => {
    const assertCurrent = vi.fn(async () => {
      throw new Error("superseded generation");
    });
    const { adapter, inspect, inspectLegacy, run } = createHarness();

    await expect(adapter.observeForwards({ forwards: [forward], assertCurrent })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.authority },
    ]);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
  });

  it("fences registry evidence before inspecting a host owner", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter, inspect } = createHarness({
      run: async () => {
        current = false;
        return capturedForwardList(noActiveForwards);
      },
    });

    await expect(adapter.observeForwards({ forwards: [forward], assertCurrent })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.authority },
    ]);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fences completed host evidence before returning it", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter } = createHarness({
      inspect: async () => {
        current = false;
        return { state: "owned", pid: 4_321 };
      },
    });

    await expect(adapter.observeForwards({ forwards: [forward], assertCurrent })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.authority },
    ]);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it("uses explicit argv and an allowlisted environment", async () => {
    const environment = {
      HOME: "/home/tester",
      NVIDIA_INFERENCE_API_KEY: "provider-secret",
      OPENSHELL_GATEWAY: "hostile-gateway",
      OPENSHELL_GATEWAY_ENDPOINT: "https://hostile.invalid",
      OPENSHELL_LOCAL_TLS_DIR: "/hostile/tls",
      OPENSHELL_TOKEN: "openshell-secret",
      OPENSHELL_WORKSPACE: "hostile-workspace",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/tester/.config",
    };
    const { adapter, run } = createHarness({
      environment,
      runtimeSelection: { ...runtimeSelection, localTlsDir: "/authority/tls" },
    });

    await adapter.observeForwards({ forwards: [forward], timeoutMs: 4_321 });

    expect(run).toHaveBeenCalledExactlyOnceWith(
      executable,
      buildCliOpenShellForwardListArgs(forward),
      {
        timeoutMs: 4_321,
        outputLimitBytes: 64 * 1_024,
        environment: {
          HOME: "/home/tester",
          OPENSHELL_GATEWAY: "nemoclaw",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
          OPENSHELL_WORKSPACE: "default",
          PATH: "/usr/bin",
          XDG_CONFIG_HOME: "/home/tester/.config",
        },
      },
    );
  });

  it("omits an empty XDG_CONFIG_HOME from the subprocess environment", async () => {
    const { adapter, run } = createHarness({
      environment: {
        HOME: "/home/tester",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "",
      },
    });

    await adapter.observeForwards({ forwards: [forward] });

    expect(run).toHaveBeenCalledExactlyOnceWith(
      executable,
      buildCliOpenShellForwardListArgs(forward),
      expect.objectContaining({
        environment: {
          HOME: "/home/tester",
          OPENSHELL_GATEWAY: "nemoclaw",
          OPENSHELL_WORKSPACE: "default",
          PATH: "/usr/bin",
        },
      }),
    );
    expect(run.mock.calls[0]?.[2].environment).not.toHaveProperty("XDG_CONFIG_HOME");
  });

  it.each([
    [
      "authentication failure",
      captured(1, "", "unauthorized token=private-value"),
      errors.authentication,
    ],
    ["timeout", captured(null, "", "private-value", { timedOut: true }), errors.timeout],
    ["transport loss", captured(null, "", "private-value", { signal: "SIGHUP" }), errors.transport],
    ["command failure", captured(2, "", "private-value"), errors.command],
  ])("returns a fixed typed error for %s", async (_case, command, error) => {
    const { adapter, inspect } = createHarness({ run: async () => command });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "indeterminate", forward, error },
    ]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("bounds a registry command that never settles", async () => {
    const run = vi.fn<RunCommand>(() => new Promise(() => {}));
    const { adapter, inspect } = createHarness({ run });

    await expect(adapter.observeForwards({ forwards: [forward], timeoutMs: 1 })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.timeout },
    ]);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      executable,
      buildCliOpenShellForwardListArgs(forward),
      expect.objectContaining({ timeoutMs: 1 }),
    );
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not fall back to direct ownership when the legacy list command fails", async () => {
    const { adapter, inspect } = createHarness({
      inspect: async () => ({ state: "owned", pid: 4_321 }),
      run: async () => captured(1, "", "gateway unavailable"),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.command },
    ]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not inspect listeners after malformed registry evidence", async () => {
    const { adapter, inspect, inspectLegacy } = createHarness({
      run: async () => captured(0, `${legacyForwardList}\n${legacyForwardList.split("\n")[1]}`),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.schema },
    ]);
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
  });

  it.each([
    ["a different PID", { state: "owned", pid: 9_876 } as const],
    ["no owner", { state: "not_owned" } as const],
    ["indeterminate ownership", { state: "indeterminate" } as const],
  ])("rejects a legacy row with %s", async (_case, legacyInspection) => {
    const { adapter, inspect, inspectLegacy } = createHarness({
      inspectLegacy: async () => legacyInspection,
      run: async () => captured(0, legacyForwardList),
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.ownership },
    ]);
    expect(inspectLegacy).toHaveBeenCalledExactlyOnceWith(forward, 4_312, 15_000);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses the default host probe to prove a stable direct owner", async () => {
    const directExecutable = process.execPath;
    const hostProbe = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(captured(0, "4321\n"))
      .mockResolvedValueOnce(captured(0, `${directExecutable}\n/mach_kernel\n`))
      .mockResolvedValueOnce(
        captured(
          0,
          `${[directExecutable, ...buildCliOpenShellForwardServiceArgs(forward)].join(" ")}\n`,
        ),
      )
      .mockResolvedValueOnce(captured(0, "4321\n"));
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable: directExecutable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe,
      platform: "darwin",
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
    });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "owned", forward },
    ]);
    expect(hostProbe.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["/usr/sbin/lsof", ["-ti4TCP:18789", "-sTCP:LISTEN"]],
      ["/usr/bin/codesign", ["-h", "4321"]],
      ["/bin/ps", ["-ww", "-p", "4321", "-o", "args="]],
      ["/usr/sbin/lsof", ["-ti4TCP:18789", "-sTCP:LISTEN"]],
    ]);
  });

  it.each([
    [
      "omits it",
      (command: string) => command.replace(" --gateway-endpoint https://127.0.0.1:8080", ""),
    ],
    [
      "changes it",
      (command: string) => command.replace("https://127.0.0.1:8080", "https://127.0.0.1:8081"),
    ],
  ])(
    "rejects an otherwise exact direct owner that %s for the gateway endpoint",
    async (_case, alter) => {
      const directExecutable = process.execPath;
      const exactCommand = [directExecutable, ...buildCliOpenShellForwardServiceArgs(forward)].join(
        " ",
      );
      const hostProbe = vi
        .fn<RunCommand>()
        .mockResolvedValueOnce(captured(0, "4321\n"))
        .mockResolvedValueOnce(captured(0, `${directExecutable}\n/mach_kernel\n`))
        .mockResolvedValueOnce(captured(0, `${alter(exactCommand)}\n`))
        .mockResolvedValueOnce(captured(0, "4321\n"));
      const adapter = createCliOpenShellForwardAdapter({
        environment: {},
        executable: directExecutable,
        gatewayEndpoint: forward.gatewayEndpoint,
        hostProbe,
        platform: "darwin",
        run: async () => capturedForwardList(noActiveForwards),
        runtimeSelection,
      });

      await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
        { state: "foreign", forward },
      ]);
    },
  );

  it.each([
    ["no hosting executable", "", { state: "indeterminate", forward, error: errors.ownership }],
    [
      "a relative hosting executable",
      "openshell\n",
      { state: "indeterminate", forward, error: errors.ownership },
    ],
    [
      "a foreign executable that also maps the trusted binary",
      `/usr/bin/python3\n${process.execPath}\n`,
      { state: "foreign", forward },
    ],
  ] as const)(
    "rejects Darwin codesign hosting evidence with %s",
    async (_case, imageEvidence, expected) => {
      const hostProbe = vi
        .fn<HostProbe>()
        .mockResolvedValueOnce(captured(0, "4321\n"))
        .mockResolvedValueOnce(captured(0, imageEvidence))
        .mockResolvedValueOnce(captured(0, "4321\n"));
      const adapter = createCliOpenShellForwardAdapter({
        environment: {},
        executable: process.execPath,
        gatewayEndpoint: forward.gatewayEndpoint,
        hostProbe,
        platform: "darwin",
        run: async () => capturedForwardList(noActiveForwards),
        runtimeSelection,
      });

      await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([expected]);
      expect(hostProbe.mock.calls.some(([command]) => command === "/bin/ps")).toBe(false);
    },
  );

  it.each([
    ["an empty valid table", "empty", { state: "absent", forward }],
    [
      "a malformed table",
      "malformed",
      { state: "indeterminate", forward, error: errors.ownership },
    ],
  ] as const)("interprets Linux /proc with %s", async (_case, tcp, expected) => {
    const fixture = createLinuxProcFixture({ tcp });
    const hostProbe = vi.fn<HostProbe>(async () => missingCommand());
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
    });

    try {
      await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([expected]);
    } finally {
      fixture.remove();
    }
  });

  it.each([
    ["the exact executable", "expected", { state: "owned", forward }],
    ["a different executable", "foreign", { state: "foreign", forward }],
  ] as const)("classifies a Linux /proc owner with %s", async (_case, owner, expected) => {
    const fixture = createLinuxProcFixture({ executableOwner: owner });
    const hostProbe = vi.fn<HostProbe>(async (command) => {
      return command === "/usr/bin/lsof"
        ? missingCommand()
        : captured(
            0,
            `${[fixture.executable, ...buildCliOpenShellForwardServiceArgs(forward)].join(" ")}\n`,
          );
    });
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable: fixture.executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe,
      platform: "linux",
      procRoot: fixture.procRoot,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
    });

    try {
      await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([expected]);
    } finally {
      fixture.remove();
    }
  });

  it.each([
    ["an incomplete process scan", true, 50_000],
    ["the configured work limit", false, 1],
    ["a zero configured work limit", false, 0],
  ])("fails closed when Linux /proc reaches %s", async (_case, incomplete, procWorkLimit) => {
    const fixture = createLinuxProcFixture({ incomplete });
    const hostProbe = vi.fn<HostProbe>(async () => missingCommand());
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable: fixture.executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe,
      platform: "linux",
      procRoot: fixture.procRoot,
      procWorkLimit,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
    });

    try {
      await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
        { state: "indeterminate", forward, error: errors.ownership },
      ]);
    } finally {
      fixture.remove();
    }
  });

  it.each([
    {
      case: "remains the same",
      expected: { state: "stale", forward } as const,
      incomplete: false,
      drift: false,
    },
    {
      case: "has an unreadable unrelated process",
      expected: { state: "stale", forward } as const,
      incomplete: true,
      drift: false,
    },
    {
      case: "gains another listener",
      expected: { state: "indeterminate", forward, error: errors.ownership } as const,
      incomplete: false,
      drift: true,
    },
  ])(
    "accepts Linux /proc legacy proof only when its sole PID $case",
    async ({ drift, expected, incomplete }) => {
      const fixture = createLinuxProcFixture({ incomplete, pid: 4_312 });
      const hostProbe = vi.fn<HostProbe>(async () => missingCommand());
      let nowCalls = 0;
      const adapter = createCliOpenShellForwardAdapter({
        environment: {},
        executable: fixture.executable,
        gatewayEndpoint: forward.gatewayEndpoint,
        hostProbe,
        now: () => {
          nowCalls += 1;
          invokeWhen(drift && nowCalls === 4, () => fixture.addSocketOwner(9_876));
          return 0;
        },
        platform: "linux",
        procRoot: fixture.procRoot,
        run: async () => captured(0, legacyForwardList),
        runtimeSelection,
      });

      try {
        await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([expected]);
        expect(hostProbe).not.toHaveBeenCalled();
      } finally {
        fixture.remove();
      }
    },
  );

  it("fails closed on native Windows without invoking a host owner inspector", async () => {
    const { adapter, inspect, run } = createHarness({ platform: "win32" });

    await expect(adapter.observeForwards({ forwards: [forward] })).resolves.toEqual([
      { state: "indeterminate", forward, error: errors.ownership },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("CLI OpenShell direct forward start", () => {
  it.each([
    {
      state: "owned",
      output: noActiveForwards,
      inspection: { state: "owned", pid: 4_321 } as const,
      expected: { state: "reused", forward },
    },
    {
      state: "stale",
      output: legacyForwardList,
      inspection: { state: "foreign", pids: [4_312] } as const,
      expected: { state: "refused", observation: { state: "stale", forward } },
    },
    {
      state: "foreign",
      output: noActiveForwards,
      inspection: { state: "foreign", pids: [9_876] } as const,
      expected: { state: "refused", observation: { state: "foreign", forward } },
    },
    {
      state: "indeterminate",
      output: noActiveForwards,
      inspection: { state: "indeterminate" } as const,
      expected: {
        state: "refused",
        observation: { state: "indeterminate", forward, error: errors.ownership },
      },
    },
  ])("does not start when the observed state is $state", async (testCase) => {
    const { adapter, spawn, terminate } = createHarness({
      inspect: async () => testCase.inspection,
      probePort: async () => ({ state: "bound" }),
      run: async () => capturedForwardList(testCase.output),
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual(testCase.expected);
    expect(spawn).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("does not start after malformed registry evidence", async () => {
    const { adapter, inspect, spawn } = createHarness({
      run: async () => captured(0, "not a forward list"),
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.schema },
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not launch when a reachable endpoint has no PID owner evidence", async () => {
    const { adapter, inspect, probePort, spawn, terminate } = createHarness({
      probePort: async () => ({ state: "bound" }),
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.ownership },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(forward, undefined, 15_000);
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, 15_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("starts only after proving the owner, bound TCP port, and same owner", async () => {
    const events = new EventEmitter();
    const child = {
      exitCode: null,
      off: events.off.bind(events),
      on: events.on.bind(events),
      once: events.once.bind(events),
      pid: 4_321,
      signalCode: null,
      unref: vi.fn(),
    } as unknown as ForwardChild;
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "owned", pid: 4_321 })
      .mockResolvedValueOnce({ state: "owned", pid: 4_321 });
    const probePort = vi
      .fn<ProbePort>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce({ state: "unbound" });
    const { adapter, spawn, terminate } = createHarness({
      environment: {
        HOME: "/home/tester",
        NVIDIA_INFERENCE_API_KEY: "provider-secret",
        OPENSHELL_GATEWAY_ENDPOINT: "https://hostile.invalid",
        OPENSHELL_TOKEN: "openshell-secret",
        PATH: "/usr/bin",
      },
      inspect,
      probePort,
      spawn: () => child,
    });

    const started = await adapter.startForward({ forward });
    expect(started).toMatchObject({
      state: "started",
      forward,
      cleanup: expect.any(Function),
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      executable,
      buildCliOpenShellForwardServiceArgs(forward),
      {
        detached: true,
        environment: {
          HOME: "/home/tester",
          OPENSHELL_GATEWAY: "nemoclaw",
          OPENSHELL_WORKSPACE: "default",
          PATH: "/usr/bin",
        },
        shell: false,
        stdio: "ignore",
      },
    );
    expect(inspect).toHaveBeenNthCalledWith(1, forward, undefined, 15_000);
    expect(inspect).toHaveBeenNthCalledWith(2, forward, child.pid, 30_000);
    expect(probePort).toHaveBeenNthCalledWith(1, forward, 15_000);
    expect(probePort).toHaveBeenNthCalledWith(2, forward, 30_000);
    expect(inspect).toHaveBeenNthCalledWith(3, forward, child.pid, 30_000);
    expect(events.listenerCount("exit")).toBe(0);
    expect(events.listenerCount("error")).toBe(1);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(started.state).toBe("started");
    expect(() => events.emit("error", new Error("late private child diagnostic"))).not.toThrow();
    const cleanup = (started as Extract<typeof started, { state: "started" }>).cleanup;
    const assertCurrent = vi.fn(async () => undefined);
    await expect(cleanup({ assertCurrent })).resolves.toEqual({ state: "released" });
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenNthCalledWith(3, forward, 5_000);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it("does not clean up a started child after cleanup authority drifts", async () => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "owned", pid: 4_321 })
      .mockResolvedValueOnce({ state: "owned", pid: 4_321 });
    const probePort = vi
      .fn<ProbePort>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "bound" });
    const { adapter, terminate } = createHarness({ inspect, probePort });
    const started = await adapter.startForward({ forward });
    expect(started.state).toBe("started");
    const cleanup = (started as Extract<typeof started, { state: "started" }>).cleanup;

    await expect(
      cleanup({
        assertCurrent: async () => {
          throw new Error("superseded generation");
        },
      }),
    ).resolves.toEqual({
      state: "indeterminate",
      forwards: [forward],
      error: errors.authority,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("cleans up when the bound port owner changes before confirmation", async () => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "owned", pid: 4_321 })
      .mockResolvedValueOnce({ state: "foreign", pids: [9_876] });
    const probePort = vi
      .fn<ProbePort>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce({ state: "unbound" });
    const { adapter, child, terminate } = createHarness({ inspect, probePort });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "refused",
      observation: { state: "foreign", forward },
    });
    expect(inspect).toHaveBeenNthCalledWith(3, forward, child.pid, 30_000);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenCalledTimes(3);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("cleans up after one indeterminate post-spawn owner inspection without retrying", async () => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "indeterminate" });
    const { adapter, child, probePort, sleep, terminate } = createHarness({ inspect });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.ownership,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenNthCalledWith(2, forward, child.pid, 30_000);
    expect(sleep).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenNthCalledWith(1, forward, 15_000);
    expect(probePort).toHaveBeenNthCalledWith(2, forward, 5_000);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("refuses a start when the preflight authority fence is stale", async () => {
    const assertCurrent = vi.fn(async () => {
      throw new Error("superseded generation");
    });
    const { adapter, inspect, run, spawn, terminate } = createHarness();

    await expect(adapter.startForward({ forward, assertCurrent })).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.authority },
    });
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("refuses a start when authority changes during preflight reachability", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter, spawn, terminate } = createHarness({
      probePort: async () => {
        current = false;
        return { state: "unbound" };
      },
    });

    await expect(adapter.startForward({ forward, assertCurrent })).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.authority },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("cleans a spawned process when authority changes after mutation", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const { adapter, child, probePort, spawn, terminate } = createHarness();
    spawn.mockImplementation(() => {
      current = false;
      return child;
    });

    await expect(adapter.startForward({ forward, assertCurrent })).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.authority,
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenNthCalledWith(1, forward, 15_000);
    expect(probePort).toHaveBeenNthCalledWith(2, forward, 5_000);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it.each(["owner", "reachability", "confirmation"] as const)(
    "cleans the spawned process when authority changes during %s proof",
    async (boundary) => {
      let current = true;
      let inspection = 0;
      let probe = 0;
      const assertCurrent = vi.fn(async () => {
        throwSupersededWhen(!current);
      });
      const inspect = vi.fn<InspectListener>(async () => {
        inspection += 1;
        const firstInspection = inspection === 1;
        invokeWhen(inspection === 2 && boundary === "owner", () => {
          current = false;
        });
        invokeWhen(inspection === 3 && boundary === "confirmation", () => {
          current = false;
        });
        return firstInspection ? { state: "unbound" } : { state: "owned", pid: 4_321 };
      });
      const probePort = vi.fn<ProbePort>(async () => {
        probe += 1;
        invokeWhen(probe === 2 && boundary === "reachability", () => {
          current = false;
        });
        return probe === 2 && boundary !== "owner" ? { state: "bound" } : { state: "unbound" };
      });
      const { adapter, child, terminate } = createHarness({ inspect, probePort });

      await expect(adapter.startForward({ forward, assertCurrent })).resolves.toEqual({
        state: "failed",
        forward,
        effect: "none",
        error: errors.authority,
      });
      expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
      expect(probePort).toHaveBeenLastCalledWith(forward, 5_000);
      expect(child.unref).not.toHaveBeenCalled();
    },
  );

  it("rejects a different post-bind owner and proves cleanup", async () => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "foreign", pids: [9_876] });
    const { adapter, child, probePort, terminate } = createHarness({ inspect });

    await expect(adapter.startForward({ forward, timeoutMs: 1 })).resolves.toEqual({
      state: "refused",
      observation: { state: "foreign", forward },
    });
    expect(inspect).toHaveBeenNthCalledWith(2, forward, child.pid, 1);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenNthCalledWith(1, forward, 1);
    expect(probePort).toHaveBeenNthCalledWith(2, forward, 5_000);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("does not accept owned evidence for a different spawned PID", async () => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "owned", pid: 9_876 });
    const { adapter, child, probePort, terminate } = createHarness({ inspect });

    await expect(adapter.startForward({ forward, timeoutMs: 1 })).resolves.toEqual({
      state: "refused",
      observation: { state: "foreign", forward },
    });
    expect(inspect).toHaveBeenNthCalledWith(2, forward, child.pid, 1);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(probePort).toHaveBeenNthCalledWith(1, forward, 1);
    expect(probePort).toHaveBeenNthCalledWith(2, forward, 5_000);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it.each([
    {
      cleanup: "termination fails",
      cleanupProbe: { state: "unbound" } as const,
      terminate: async (): Promise<boolean> => {
        throw new Error("private termination diagnostic");
      },
    },
    {
      cleanup: "termination is unproved",
      cleanupProbe: { state: "unbound" } as const,
      terminate: async (): Promise<boolean> => false,
    },
    {
      cleanup: "the port remains bound after termination",
      cleanupProbe: { state: "bound" } as const,
      terminate: async (): Promise<boolean> => true,
    },
  ])("returns cleanup uncertainty when $cleanup", async (testCase) => {
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "foreign", pids: [9_876] });
    const probePort = vi
      .fn<ProbePort>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValue(testCase.cleanupProbe);
    const { adapter, child, terminate } = createHarness({
      inspect,
      probePort,
      terminate: testCase.terminate,
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "cleanup_uncertain",
      forward,
      effect: "possible",
      error: errors.cleanup,
    });
    expect(terminate).toHaveBeenCalledExactlyOnceWith(child, 5_000);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("absorbs a delayed spawn error when the child PID is invalid", async () => {
    const events = new EventEmitter();
    const invalidChild = {
      exitCode: null,
      off: events.off.bind(events),
      on: events.on.bind(events),
      once: events.once.bind(events),
      pid: undefined,
      signalCode: null,
      unref: vi.fn(),
    } as unknown as ForwardChild;
    const { adapter, probePort, terminate } = createHarness({
      spawn: () => invalidChild,
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "cleanup_uncertain",
      forward,
      effect: "possible",
      error: errors.cleanup,
      failure: { stage: "spawn", reason: "invalid_child_identity" },
    });
    expect(() => events.emit("error", new Error("delayed private spawn error"))).not.toThrow();
    expect(terminate).not.toHaveBeenCalled();
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, 15_000);
    expect(invalidChild.unref).toHaveBeenCalledOnce();
  });

  it("uses exact process-group SIGKILL and verifies release after ESRCH", async () => {
    const child = {
      exitCode: null,
      off: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      pid: 4_321,
      signalCode: null,
      unref: vi.fn(),
    } as unknown as ForwardChild;
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "foreign", pids: [9_876] });
    const signalProcess = vi.fn<SignalProcess>(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const hostProbe = vi.fn<HostProbe>();
    const probePort = vi.fn<ProbePort>(async () => ({ state: "unbound" }));
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe,
      inspect,
      platform: "linux",
      probePort,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
      signalProcess,
      spawn: () => child,
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "refused",
      observation: { state: "foreign", forward },
    });
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(-4_321, "SIGKILL");
    expect(hostProbe).not.toHaveBeenCalled();
    expect(probePort).toHaveBeenCalledTimes(2);
    expect(probePort).toHaveBeenLastCalledWith(forward, expect.any(Number));
  });

  it("treats uncertain process-group inspection as uncertain cleanup", async () => {
    const child = {
      exitCode: null,
      off: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      pid: 4_321,
      signalCode: null,
      unref: vi.fn(),
    } as unknown as ForwardChild;
    const inspect = vi
      .fn<InspectListener>()
      .mockResolvedValueOnce({ state: "unbound" })
      .mockResolvedValueOnce({ state: "foreign", pids: [9_876] });
    const signalProcess = vi.fn<SignalProcess>();
    const hostProbe = vi.fn<HostProbe>(async () => captured(0));
    const probePort = vi.fn<ProbePort>(async () => ({ state: "unbound" }));
    const adapter = createCliOpenShellForwardAdapter({
      environment: {},
      executable,
      gatewayEndpoint: forward.gatewayEndpoint,
      hostProbe,
      inspect,
      platform: "linux",
      probePort,
      run: async () => capturedForwardList(noActiveForwards),
      runtimeSelection,
      signalProcess,
      spawn: () => child,
    });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "cleanup_uncertain",
      forward,
      effect: "possible",
      error: errors.cleanup,
    });
    expect(signalProcess).toHaveBeenCalledExactlyOnceWith(-4_321, "SIGKILL");
    expect(hostProbe).toHaveBeenCalledExactlyOnceWith(
      "/bin/ps",
      ["-axo", "pgid=,stat="],
      expect.any(Object),
    );
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, expect.any(Number));
  });

  it("fails closed before spawn on native Windows", async () => {
    const { adapter, spawn } = createHarness({ platform: "win32" });

    await expect(adapter.startForward({ forward })).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.ownership,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("CLI OpenShell legacy forward retirement", () => {
  it("omits the workspace flag for legacy CLIs that predate workspace selection", async () => {
    const run = vi.fn<RunCommand>(async (_executable, args) =>
      args.includes("list") ? captured(0, legacyForwardList) : captured(0),
    );
    const { adapter } = createHarness({
      legacyForwardWorkspaceSelection: "implicit-default",
      run,
    });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({ state: "retired", forward });
    expect(run.mock.calls.filter(([, args]) => args.includes("list"))).not.toEqual([]);
    expect(run.mock.calls.every(([, args]) => !args.includes("--workspace"))).toBe(true);
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
  });

  it("checks authority again, stops once, and verifies release", async () => {
    const operations: string[] = [];
    const run: RunCommand = async (_executable, args) => {
      const operation = args.includes("list") ? "list" : "stop";
      operations.push(operation);
      return operation === "list" ? captured(0, legacyForwardList) : captured(0);
    };
    const inspectLegacy: InspectLegacyListener = async (_identity, expectedPid) => {
      operations.push(`legacy:${String(expectedPid)}`);
      return { state: "owned", pid: expectedPid };
    };
    const probePort: ProbePort = async () => {
      operations.push("probe");
      return { state: "unbound" };
    };
    const authorize = vi.fn(async () => {
      operations.push("authorize");
    });
    const { adapter, run: runMock } = createHarness({ inspectLegacy, probePort, run });

    await expect(adapter.retireLegacyForward({ forward, authorize })).resolves.toEqual({
      state: "retired",
      forward,
    });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenNthCalledWith(1, forward);
    expect(authorize).toHaveBeenNthCalledWith(2, forward);
    expect(operations).toEqual([
      "list",
      "legacy:4312",
      "authorize",
      "list",
      "legacy:4312",
      "authorize",
      "stop",
      "probe",
    ]);
    expect(runMock.mock.calls.filter(([, args]) => args.includes("stop"))).toEqual([
      [
        executable,
        buildCliOpenShellLegacyForwardStopArgs(forward),
        expect.objectContaining({
          environment: {
            OPENSHELL_GATEWAY: "nemoclaw",
            OPENSHELL_WORKSPACE: "default",
          },
          outputLimitBytes: 64 * 1_024,
        }),
      ],
    ]);
  });

  it.each([
    ["owned", "not_needed", noActiveForwards, { state: "owned", pid: 4_321 } as const],
    ["absent", "not_needed", noActiveForwards, { state: "unbound" } as const],
    ["foreign", "refused", noActiveForwards, { state: "foreign", pids: [9_876] } as const],
    ["indeterminate", "refused", noActiveForwards, { state: "indeterminate" } as const],
  ])(
    "returns %s as %s without requesting authority or stopping",
    async (_state, expectedState, output, inspection) => {
      const authorize = vi.fn(async () => {});
      const { adapter, run } = createHarness({
        inspect: async () => inspection,
        run: async () => capturedForwardList(output),
      });

      const result = await adapter.retireLegacyForward({ forward, authorize });

      expect(result.state).toBe(expectedState);
      expect(authorize).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("refuses retirement when its initial currentness fence is stale", async () => {
    const assertCurrent = vi.fn(async () => {
      throw new Error("superseded generation");
    });
    const authorize = vi.fn(async () => {});
    const { adapter, inspectLegacy, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize }),
    ).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.authority },
    });
    expect(run).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("does not stop when the second destructive authorization revokes currentness", async () => {
    let current = true;
    let authorizations = 0;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const authorize = vi.fn(async () => {
      authorizations += 1;
      invokeWhen(authorizations === 2, () => {
        current = false;
      });
    });
    const { adapter, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize }),
    ).resolves.toEqual({ state: "failed", forward, effect: "none", error: errors.authority });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
  });

  it("does not stop when authority fails", async () => {
    const { adapter, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({
        forward,
        authorize: async () => {
          throw new Error("private authority diagnostic");
        },
      }),
    ).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.authority,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reconciles release when currentness changes after a successful stop", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const run = vi.fn<RunCommand>(async (_executable, args) => {
      const isList = args.includes("list");
      current = isList ? current : false;
      return isList ? captured(0, legacyForwardList) : captured(0);
    });
    const { adapter, probePort } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "mutation_uncertain",
      forward,
      effect: "possible",
      error: errors.authority,
    });
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, 5_000);
  });

  it("does not stop when the post-authority observation changes", async () => {
    const run = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(captured(0, legacyForwardList))
      .mockResolvedValueOnce(capturedForwardList(noActiveForwards));
    const { adapter } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "not_needed",
      observation: { state: "absent", forward },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
  });

  it("does not stop when the legacy PID changes after authority", async () => {
    const changedLegacyForwardList = [listHeader, "demo 127.0.0.1 18789 9876 running"].join("\n");
    const run = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(captured(0, legacyForwardList))
      .mockResolvedValueOnce(captured(0, changedLegacyForwardList))
      .mockResolvedValueOnce(captured(0));
    const { adapter, inspectLegacy } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.ownership,
    });
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
    expect(inspectLegacy).toHaveBeenNthCalledWith(1, forward, 4_312, 15_000);
    expect(inspectLegacy).toHaveBeenNthCalledWith(2, forward, 9_876, 15_000);
  });

  it("returns mutation uncertainty after one timed-out stop", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const run = vi.fn<RunCommand>(async (_executable, args) => {
      const isList = args.includes("list");
      current = isList ? current : false;
      return isList
        ? captured(0, legacyForwardList)
        : captured(null, "", "private stop diagnostic", { timedOut: true });
    });
    const { adapter, inspectLegacy } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({
        forward,
        assertCurrent,
        authorize: async () => {},
      }),
    ).resolves.toEqual({
      state: "mutation_uncertain",
      forward,
      effect: "possible",
      error: errors.timeout,
    });
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
    expect(run.mock.calls.filter(([, args]) => args.includes("list"))).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.at(-1)?.[2].timeoutMs).toBeGreaterThan(0);
    expect(run.mock.calls.at(-1)?.[2].timeoutMs).toBeLessThanOrEqual(5_000);
    expect(inspectLegacy).toHaveBeenCalledTimes(3);
  });

  it("returns cleanup uncertainty when a stopped forward remains bound", async () => {
    const run: RunCommand = async (_executable, args) =>
      args.includes("list") ? captured(0, legacyForwardList) : captured(0);
    const { adapter } = createHarness({
      probePort: async () => ({ state: "bound" }),
      run,
    });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "release_unproved",
      forward,
      effect: "possible",
      error: errors.cleanup,
    });
  });
});
