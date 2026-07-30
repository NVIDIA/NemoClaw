// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  applyPodmanManagedStartupRootRequest,
  getPodmanManagedStartupFailureTransaction,
} from "./podman-root-apply";
import type {
  PodmanManagedStartupCommandResult,
  PodmanManagedStartupRuntimeDeps,
  RunManagedStartupPodmanCommand,
} from "./podman-runtime";
import { encodeManagedStartupProfile } from "./profile";
import {
  createManagedStartupRootApplyRequest,
  parseManagedStartupRootApplyRequest,
} from "./root-apply";
import { MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY } from "./shared-state-transaction";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
const SOCKET_URL = `unix://${SOCKET_PATH}`;
const SOCKET_AUTHORITY = {
  directoryChain: [
    {
      device: "8",
      inode: "7000",
      mode: "448",
      ownerUid: "1000",
      path: "/run/user/1000/podman",
    },
  ],
  device: "8",
  inode: "9001",
  ownerUid: "1000",
  socketPath: SOCKET_PATH,
} as const;
const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;

function testDeps(
  run: RunManagedStartupPodmanCommand,
  assertSocketAuthority: NonNullable<
    PodmanManagedStartupRuntimeDeps["assertSocketAuthority"]
  > = vi.fn(),
) {
  return { assertSocketAuthority, run };
}

function requestFor(agent: "openclaw" | "hermes" | "langchain-deepagents-code") {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent)),
  });

  it("does not execute root mutation after socket authority changes", () => {
    const baseline = successfulRunner();
    applyPodmanManagedStartupRootRequest(
      {
        containerId: CONTAINER_ID,
        request: requestFor("openclaw"),
        socketAuthority: SOCKET_AUTHORITY,
        socketPath: SOCKET_PATH,
      },
      testDeps(baseline),
    );
    const mutationIndex = vi
      .mocked(baseline)
      .mock.calls.findIndex((call) => call[1].includes("--apply-root-stdin"));
    expect(mutationIndex).toBeGreaterThan(0);

    const run = successfulRunner();
    expect(() =>
      applyPodmanManagedStartupRootRequest(
        {
          containerId: CONTAINER_ID,
          request: requestFor("openclaw"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
        },
        testDeps(run, () => {
          if (vi.mocked(run).mock.calls.length >= mutationIndex) {
            throw new Error("socket authority changed");
          }
        }),
      ),
    ).toThrow("socket authority changed");
    expect(vi.mocked(run).mock.calls.some((call) => call[1].includes("--apply-root-stdin"))).toBe(
      false,
    );
  });
}

function podmanInfo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    host: { security: { rootless: true } },
    store: {
      graphRoot: "/home/test/.local/share/containers/storage",
      runRoot: "/run/user/1000/containers",
    },
    ...overrides,
  });
}

function stableInspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      State: { Dead: false, Paused: false, Restarting: false, Running: true },
      ...overrides,
    },
  ]);
}

function result(
  status: number | null,
  overrides: Partial<PodmanManagedStartupCommandResult> = {},
): PodmanManagedStartupCommandResult {
  return { status, stderr: "", stdout: "", ...overrides };
}

function successfulRunner(
  mutation?: (
    args: readonly string[],
    options: Parameters<RunManagedStartupPodmanCommand>[2],
  ) => PodmanManagedStartupCommandResult,
): RunManagedStartupPodmanCommand {
  return vi.fn((_command, args, options) => {
    const operation = args.slice(2);
    if (operation[0] === "info") return result(0, { stdout: podmanInfo() });
    if (operation[0] === "container" && operation[1] === "inspect") {
      return result(0, { stdout: stableInspect() });
    }
    return mutation?.(operation, options) ?? result(0);
  });
}

describe("Podman managed-startup root applicator", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("pins the rootless socket and exact identities before fixed root stdin for %s", (agent) => {
    const request = requestFor(agent);
    const run = successfulRunner();

    const transaction = applyPodmanManagedStartupRootRequest(
      {
        containerId: CONTAINER_ID,
        request,
        socketAuthority: SOCKET_AUTHORITY,
        socketPath: SOCKET_PATH,
      },
      testDeps(run),
    );

    expect(transaction).toMatchObject({
      agent,
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
      runtime: {
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        socketAuthority: SOCKET_AUTHORITY,
        socketPath: SOCKET_PATH,
      },
    });
    expect(run).toHaveBeenCalledTimes(8);
    for (const call of vi.mocked(run).mock.calls) {
      expect(call[0]).toBe("podman");
      expect(call[1].slice(0, 2)).toEqual(["--url", SOCKET_URL]);
    }
    const applyCall = vi
      .mocked(run)
      .mock.calls.find((call) => call[1].includes("--apply-root-stdin"));
    expect(applyCall).toBeDefined();
    const applyArgs = applyCall?.[1].slice(2);
    expect(applyArgs).toEqual([
      "exec",
      "--interactive",
      "--user",
      "0:0",
      "--workdir",
      "/",
      CONTAINER_ID,
      "/usr/bin/env",
      "-i",
      "HOME=/root",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "/usr/local/bin/node",
      "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
      "--apply-root-stdin",
      "--agent",
      agent,
    ]);
    expect(applyArgs?.join(" ")).not.toContain(request.encodedProfile);
    const applyOptions = applyCall?.[2];
    expect(parseManagedStartupRootApplyRequest(String(applyOptions?.input))).toEqual(request);
    expect(applyOptions).toMatchObject({
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });

    const receiptCall = vi
      .mocked(run)
      .mock.calls.find((call) => call[1].includes("nemoclaw-transaction-probe"));
    expect(receiptCall?.[1].slice(2)).toEqual([
      "exec",
      "--user",
      "0:0",
      "--workdir",
      "/",
      CONTAINER_ID,
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "/bin/sh",
      "-c",
      'if [ -d "$1" ] && [ ! -L "$1" ]; then exit 0; fi; if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 1; fi; exit 2',
      "nemoclaw-transaction-probe",
      MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
    ]);
  });

  it("retries a lost acknowledgement with identical root command and stdin", () => {
    let applies = 0;
    const run = successfulRunner((args) => {
      if (!args.includes("--apply-root-stdin")) return result(0);
      applies += 1;
      return applies === 1 ? result(1, { stderr: "lost ack" }) : result(0);
    });

    applyPodmanManagedStartupRootRequest(
      {
        containerId: CONTAINER_ID,
        request: requestFor("openclaw"),
        socketAuthority: SOCKET_AUTHORITY,
        socketPath: SOCKET_PATH,
      },
      testDeps(run),
    );

    const applyCalls = vi
      .mocked(run)
      .mock.calls.filter((call) => call[1].includes("--apply-root-stdin"));
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1]).toEqual(applyCalls[0]);
  });

  it("returns no transaction when the canonical receipt proves an already-finalized profile", () => {
    const run = successfulRunner((args) =>
      args.includes("nemoclaw-transaction-probe") ? result(1) : result(0),
    );
    expect(
      applyPodmanManagedStartupRootRequest(
        {
          containerId: CONTAINER_ID,
          request: requestFor("openclaw"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
        },
        testDeps(run),
      ),
    ).toBeNull();
  });

  it("attaches the exact rollback transaction when both attempts fail", () => {
    const run = successfulRunner((args) =>
      args.includes("--apply-root-stdin") ? result(1, { stderr: "exec failed" }) : result(0),
    );
    let failure: unknown;
    try {
      applyPodmanManagedStartupRootRequest(
        {
          containerId: CONTAINER_ID,
          request: requestFor("hermes"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
        },
        testDeps(run),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining("exec failed") }),
    );
    expect(getPodmanManagedStartupFailureTransaction(failure)).toMatchObject({
      agent: "hermes",
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
      runtime: { socketPath: SOCKET_PATH },
    });
  });

  it("retains rollback context when a lost acknowledgement is followed by runtime drift", () => {
    let infoCalls = 0;
    const run = vi.fn((_command, args: readonly string[]) => {
      const operation = args.slice(2);
      if (operation[0] === "info") {
        infoCalls += 1;
        return result(0, {
          stdout:
            infoCalls < 3
              ? podmanInfo()
              : podmanInfo({
                  store: {
                    graphRoot: "/different/storage",
                    runRoot: "/run/user/1000/containers",
                  },
                }),
        });
      }
      if (operation[0] === "container") return result(0, { stdout: stableInspect() });
      if (operation.includes("--apply-root-stdin")) {
        return result(1, { stderr: "ack lost" });
      }
      return result(0);
    });
    let failure: unknown;
    try {
      applyPodmanManagedStartupRootRequest(
        {
          containerId: CONTAINER_ID,
          request: requestFor("openclaw"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
        },
        testDeps(run),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining("runtime identity changed") }),
    );
    expect(getPodmanManagedStartupFailureTransaction(failure)).toMatchObject({
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
      runtime: { socketPath: SOCKET_PATH },
    });
  });

  it("fails closed when the receipt proof is unavailable", () => {
    const run = successfulRunner((args) =>
      args.includes("nemoclaw-transaction-probe")
        ? result(null, { error: new Error("probe unavailable") })
        : result(0),
    );
    let failure: unknown;
    try {
      applyPodmanManagedStartupRootRequest(
        {
          containerId: CONTAINER_ID,
          request: requestFor("langchain-deepagents-code"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
        },
        testDeps(run),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("transaction state could not be verified"),
      }),
    );
    expect(getPodmanManagedStartupFailureTransaction(failure)).not.toBeNull();
  });

  it.each([
    {
      label: "relative socket",
      socketPath: "run/podman.sock",
      info: podmanInfo(),
      inspect: stableInspect(),
      containerId: CONTAINER_ID,
      error: /safe normalized absolute path/u,
    },
    {
      label: "non-rootless API",
      socketPath: SOCKET_PATH,
      info: podmanInfo({ host: { security: { rootless: false } } }),
      inspect: stableInspect(),
      containerId: CONTAINER_ID,
      error: /rootless Podman API/u,
    },
    {
      label: "short container identity",
      socketPath: SOCKET_PATH,
      info: podmanInfo(),
      inspect: stableInspect(),
      containerId: "b".repeat(12),
      error: /full lowercase Podman container ID/u,
    },
    {
      label: "changed container identity",
      socketPath: SOCKET_PATH,
      info: podmanInfo(),
      inspect: stableInspect({ Id: "d".repeat(64) }),
      containerId: CONTAINER_ID,
      error: /identity changed/u,
    },
    {
      label: "mutable image identity",
      socketPath: SOCKET_PATH,
      info: podmanInfo(),
      inspect: stableInspect({ Image: "registry.example/image:latest" }),
      containerId: CONTAINER_ID,
      error: /full immutable Podman image ID/u,
    },
    {
      label: "stopped container",
      socketPath: SOCKET_PATH,
      info: podmanInfo(),
      inspect: stableInspect({
        State: { Dead: false, Paused: false, Restarting: false, Running: false },
      }),
      containerId: CONTAINER_ID,
      error: /not running/u,
    },
    {
      label: "unstable running container",
      socketPath: SOCKET_PATH,
      info: podmanInfo(),
      inspect: stableInspect({
        State: { Dead: false, Paused: true, Restarting: false, Running: true },
      }),
      containerId: CONTAINER_ID,
      error: /not stably running/u,
    },
  ])("rejects $label before root exec", ({ socketPath, info, inspect, containerId, error }) => {
    const run = vi.fn((_command, args: readonly string[]) => {
      const operation = args.slice(2);
      if (operation[0] === "info") return result(0, { stdout: info });
      if (operation[0] === "container") return result(0, { stdout: inspect });
      return result(0);
    });

    expect(() =>
      applyPodmanManagedStartupRootRequest(
        {
          containerId,
          request: requestFor("openclaw"),
          socketAuthority: SOCKET_AUTHORITY,
          socketPath,
        },
        testDeps(run),
      ),
    ).toThrow(error);
    expect(vi.mocked(run).mock.calls.some((call) => call[1].includes("--apply-root-stdin"))).toBe(
      false,
    );
  });
});
