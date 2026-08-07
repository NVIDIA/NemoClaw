// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  applyDockerManagedStartupRootRequest,
  getDockerManagedStartupFailureTransaction,
} from "./docker-root-apply";
import { encodeManagedStartupProfile } from "./profile";
import {
  createManagedStartupRootApplyRequest,
  parseManagedStartupRootApplyRequest,
} from "./root-apply";
import { MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY } from "./shared-state-transaction";

const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;

function requestFor(agent: "openclaw" | "hermes" | "langchain-deepagents-code") {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent)),
  });
}

function stableInspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      State: {
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
      },
      ...overrides,
    },
  ]);
}

function successfulSpawnResult() {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    output: [null, "", ""],
    pid: 1,
    error: undefined,
  };
}

describe("Docker managed-startup root applicator", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("pins exact container/image identity and uses fixed root stdin for %s", (agent) => {
    const request = requestFor(agent);
    const dockerCapture = vi.fn(() => stableInspect());
    const dockerSpawnSync = vi.fn(() => successfulSpawnResult());

    expect(
      applyDockerManagedStartupRootRequest(
        { containerId: CONTAINER_ID, request },
        { dockerCapture, dockerSpawnSync, environment: {} },
      ),
    ).toEqual({ agent, containerId: CONTAINER_ID, image: IMAGE_ID });

    expect(dockerCapture).toHaveBeenCalledWith(["inspect", "--type", "container", CONTAINER_ID], {
      ignoreError: false,
      timeout: 30_000,
    });
    expect(dockerSpawnSync).toHaveBeenCalledTimes(2);
    const [argv, options] = dockerSpawnSync.mock.calls[0] as unknown as [
      string[],
      { input: string; timeout: number; encoding: string },
    ];
    expect(argv).toEqual([
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
    expect(argv.join(" ")).not.toContain(request.encodedProfile);
    expect(parseManagedStartupRootApplyRequest(options.input)).toEqual(request);
    expect(options).toMatchObject({ encoding: "utf8", timeout: 300_000 });
    expect(dockerSpawnSync.mock.calls[1]).toEqual([
      [
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
      ],
      { encoding: "utf8", timeout: 30_000 },
    ]);
  });

  it("forwards only allowlisted application-runtime controls through the clean root exec", () => {
    const dockerSpawnSync = vi.fn(() => successfulSpawnResult());

    applyDockerManagedStartupRootRequest(
      { containerId: CONTAINER_ID, request: requestFor("openclaw") },
      {
        dockerCapture: vi.fn(() => stableInspect()),
        dockerSpawnSync,
        environment: {
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: " 0.25 ",
          NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "03",
          NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: " 1 ",
          NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: "5000",
          NEMOCLAW_NOT_AN_APPLICATION_RUNTIME_INPUT: "must-not-cross",
        },
      },
    );

    const [argv] = dockerSpawnSync.mock.calls[0] as unknown as [string[]];
    expect(argv).toContain("NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS= 0.25 ");
    expect(argv).toContain("NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS=03");
    expect(argv).toContain("NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1");
    expect(argv).toContain("NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS=5000");
    expect(argv.join("\n")).not.toContain("NEMOCLAW_NOT_AN_APPLICATION_RUNTIME_INPUT");
  });

  it("omits an unsupported MCP shadow diagnostics value from the clean root exec", () => {
    const dockerSpawnSync = vi.fn(() => successfulSpawnResult());

    applyDockerManagedStartupRootRequest(
      { containerId: CONTAINER_ID, request: requestFor("openclaw") },
      {
        dockerCapture: vi.fn(() => stableInspect()),
        dockerSpawnSync,
        environment: {
          NEMOCLAW_MCP_SHADOW_DIAGNOSTICS: "true",
          NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS: "5000",
        },
      },
    );

    const [argv] = dockerSpawnSync.mock.calls[0] as unknown as [string[]];
    expect(argv.join("\n")).not.toContain("NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=");
    expect(argv).toContain("NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS=5000");
  });

  it("retries one lost acknowledgement with the identical pinned command and payload", () => {
    const request = requestFor("openclaw");
    const dockerSpawnSync = vi
      .fn()
      .mockReturnValueOnce({ ...successfulSpawnResult(), status: 1, stderr: "lost ack" })
      .mockReturnValueOnce(successfulSpawnResult())
      .mockReturnValueOnce(successfulSpawnResult());

    applyDockerManagedStartupRootRequest(
      { containerId: CONTAINER_ID, request },
      { dockerCapture: vi.fn(() => stableInspect()), dockerSpawnSync },
    );

    expect(dockerSpawnSync).toHaveBeenCalledTimes(3);
    expect(dockerSpawnSync.mock.calls[1]).toEqual(dockerSpawnSync.mock.calls[0]);
  });

  it("returns no pending transaction when the same profile was already finalized", () => {
    const request = requestFor("openclaw");
    const dockerSpawnSync = vi
      .fn()
      .mockReturnValueOnce(successfulSpawnResult())
      .mockReturnValueOnce({ ...successfulSpawnResult(), status: 1 });

    expect(
      applyDockerManagedStartupRootRequest(
        { containerId: CONTAINER_ID, request },
        { dockerCapture: vi.fn(() => stableInspect()), dockerSpawnSync },
      ),
    ).toBeNull();
    expect(dockerSpawnSync).toHaveBeenCalledTimes(2);
  });

  it("fails with rollback context when transaction state cannot be verified", () => {
    const request = requestFor("hermes");
    const dockerSpawnSync = vi
      .fn()
      .mockReturnValueOnce(successfulSpawnResult())
      .mockReturnValueOnce({
        ...successfulSpawnResult(),
        status: null,
        error: new Error("probe unavailable"),
      });

    let failure: unknown;
    try {
      applyDockerManagedStartupRootRequest(
        { containerId: CONTAINER_ID, request },
        { dockerCapture: vi.fn(() => stableInspect()), dockerSpawnSync },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("transaction state could not be verified"),
      }),
    );
    expect(getDockerManagedStartupFailureTransaction(failure)).toEqual({
      agent: "hermes",
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
    });
  });

  it("attaches the pinned transaction when both idempotent attempts fail", () => {
    const request = requestFor("hermes");
    const dockerSpawnSync = vi.fn(() => ({
      ...successfulSpawnResult(),
      status: 1,
      stderr: "exec failed",
    }));

    let failure: unknown;
    try {
      applyDockerManagedStartupRootRequest(
        { containerId: CONTAINER_ID, request },
        { dockerCapture: vi.fn(() => stableInspect()), dockerSpawnSync },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining("exec failed") }),
    );
    expect(getDockerManagedStartupFailureTransaction(failure)).toEqual({
      agent: "hermes",
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
    });
    expect(dockerSpawnSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "changed exact identity",
      containerId: CONTAINER_ID,
      inspect: stableInspect({ Id: "d".repeat(64) }),
      error: /identity changed/u,
    },
    {
      label: "mutable image identity",
      containerId: CONTAINER_ID,
      inspect: stableInspect({ Image: "registry.example/image:latest" }),
      error: /immutable image identity/u,
    },
    {
      label: "unstable running state",
      containerId: CONTAINER_ID,
      inspect: stableInspect({
        State: { Running: true, Paused: false, Restarting: true, Dead: false },
      }),
      error: /not stably running/u,
    },
    {
      label: "short caller identity",
      containerId: "b".repeat(12),
      inspect: stableInspect(),
      error: /full lowercase Docker container ID/u,
    },
  ])("rejects $label before root exec", ({ containerId, inspect, error }) => {
    const dockerSpawnSync = vi.fn();

    expect(() =>
      applyDockerManagedStartupRootRequest(
        { containerId, request: requestFor("openclaw") },
        { dockerCapture: vi.fn(() => inspect), dockerSpawnSync },
      ),
    ).toThrow(error);
    expect(dockerSpawnSync).not.toHaveBeenCalled();
  });
});
