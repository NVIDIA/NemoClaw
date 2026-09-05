// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildForwardServiceArgs, type ForwardServiceTarget } from "./forward-service";
import {
  inspectForwardServiceListenerOwnership,
  isForwardServiceListenerOwned,
  listLinuxProcListenerPids,
  type ForwardServiceOwnershipDeps,
} from "./forward-service-ownership";

const target: ForwardServiceTarget = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "reonboard-test",
  localHost: "127.0.0.1",
  localPort: 18_790,
  targetHost: "127.0.0.1",
  targetPort: 18_790,
};

function ownership(overrides: Partial<ForwardServiceOwnershipDeps> = {}) {
  return {
    currentUid: () => 1_000,
    inspectProcess: () => ({
      argv: [target.executable, ...buildForwardServiceArgs(target)],
      commandLine: null,
      environment: { HOME: "/home/operator" },
      executable: target.executable,
      uid: 1_000,
    }),
    listListenerPids: vi.fn(() => [4_242]),
    realpath: (value: string) => value,
    sourceEnvironment: { HOME: "/home/operator" },
    ...overrides,
  } satisfies ForwardServiceOwnershipDeps;
}

describe("direct ForwardTcp listener ownership", () => {
  it("accepts one stable listener with the exact user, executable, and target argv", () => {
    const deps = ownership();

    expect(isForwardServiceListenerOwned(target, deps)).toBe(true);
    expect(deps.listListenerPids).toHaveBeenCalledTimes(2);
  });

  it("accepts the exact ps command line when procfs argv is unavailable", () => {
    expect(
      isForwardServiceListenerOwned(
        target,
        ownership({
          inspectProcess: () => ({
            argv: null,
            commandLine: [target.executable, ...buildForwardServiceArgs(target)].join(" "),
            environment: { HOME: "/home/operator" },
            executable: target.executable,
            uid: 1_000,
          }),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["foreign user", { uid: 2_000 }],
    ["foreign executable", { executable: "/usr/bin/python3" }],
    [
      "foreign target",
      {
        argv: [
          target.executable,
          ...buildForwardServiceArgs({ ...target, sandboxName: "other-sandbox" }),
        ],
      },
    ],
  ])("rejects a %s listener", (_case, replacement) => {
    expect(
      isForwardServiceListenerOwned(
        target,
        ownership({
          inspectProcess: () => ({
            argv: [target.executable, ...buildForwardServiceArgs(target)],
            commandLine: null,
            environment: { HOME: "/home/operator" },
            executable: target.executable,
            uid: 1_000,
            ...replacement,
          }),
        }),
      ),
    ).toBe(false);
  });

  it("rejects an incomplete or changing listener scan", () => {
    const listListenerPids = vi.fn<() => readonly number[] | null>();
    listListenerPids.mockReturnValueOnce([4_242]).mockReturnValueOnce([4_243]);

    expect(isForwardServiceListenerOwned(target, ownership({ listListenerPids }))).toBe(false);
    expect(isForwardServiceListenerOwned(target, ownership({ listListenerPids: () => null }))).toBe(
      false,
    );
  });

  it("rejects a listener when the current user cannot be proven", () => {
    expect(isForwardServiceListenerOwned(target, ownership({ currentUid: () => null }))).toBe(
      false,
    );
  });

  it("rejects a listener from another OpenShell configuration home", () => {
    expect(
      isForwardServiceListenerOwned(
        target,
        ownership({
          inspectProcess: () => ({
            argv: [target.executable, ...buildForwardServiceArgs(target)],
            commandLine: null,
            environment: { HOME: "/home/other" },
            executable: target.executable,
            uid: 1_000,
          }),
        }),
      ),
    ).toBe(false);
  });

  it("uses Linux procfs when lsof cannot enumerate the listener", () => {
    const { listListenerPids: _listListenerPids, ...fallbackDeps } = ownership();
    const listLinuxProcListenerPids = vi.fn(() => [4_242]);

    expect(
      isForwardServiceListenerOwned(target, {
        ...fallbackDeps,
        platform: "linux",
        listLsofListenerPids: () => null,
        listLinuxProcListenerPids,
      }),
    ).toBe(true);
    expect(listLinuxProcListenerPids).toHaveBeenCalledTimes(2);
  });

  it("resolves a listening IPv4 socket inode to its procfs PID", () => {
    expect(
      listLinuxProcListenerPids(18_790, {
        readFile: (file) =>
          file === "/proc/net/tcp"
            ? "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n" +
              "0: 0100007F:4966 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 777\n"
            : null,
        readDirectory: (directory) =>
          ({ "/proc": ["42", "self"], "/proc/42/fd": ["3", "4"] })[directory] ?? null,
        readLink: (file) => (file.endsWith("/3") ? "socket:[777]" : "socket:[999]"),
      }),
    ).toEqual([42]);
  });

  it("reports unavailable listener enumeration distinctly", () => {
    expect(
      inspectForwardServiceListenerOwnership(target, ownership({ listListenerPids: () => null })),
    ).toEqual({ owned: false, failure: "listener-enumeration-unavailable" });
  });
});
