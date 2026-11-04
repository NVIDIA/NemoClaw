// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  inspectActivationSandboxId,
  verifyExactCleanup,
} from "../live/managed-image-activation-e2e-helpers.ts";

describe("managed image activation cleanup evidence", () => {
  it.each([
    {
      boundary: "OpenShell query",
      listStatus: 1,
      engineStatus: 0,
      listed: false,
      container: false,
    },
    { boundary: "engine query", listStatus: 0, engineStatus: 1, listed: false, container: false },
    {
      boundary: "OpenShell absence",
      listStatus: 0,
      engineStatus: 0,
      listed: true,
      container: false,
    },
    {
      boundary: "container absence",
      listStatus: 0,
      engineStatus: 0,
      listed: false,
      container: true,
    },
  ])("cleanup polling rejects failed $boundary evidence", async (scenario) => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({
      exitCode: scenario.listStatus,
      stderr: "",
      stdout: scenario.listed ? "mi-act-hermes 1m Deleting\n" : "NAME CREATED PHASE\n",
    }));
    const command = vi.fn(async (_engine: string, args: string[]) => ({
      exitCode: scenario.engineStatus,
      stderr: "",
      stdout: scenario.container && args[0] === "ps" ? "a".repeat(64) : "",
    }));
    try {
      const assertion = expect(
        verifyExactCleanup({ command } as never, { list } as never, "mi-act-hermes", {}, [
          "sandbox-1",
        ]),
      ).rejects.toThrow(scenario.listStatus || scenario.engineStatus ? /failed/ : /exhausted/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup polling succeeds only after sandbox, container and volume inventories show absence", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "NAME CREATED PHASE\n" }));
    let volumeObservations = 0;
    const command = vi.fn(async (_engine: string, args: string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        args[0] === "volume" && volumeObservations++ === 0 ? "openshell-control-sandbox-1" : "",
    }));
    try {
      const assertion = expect(
        verifyExactCleanup({ command } as never, { list } as never, "mi-act-hermes", {}, [
          "sandbox-1",
        ]),
      ).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(list).toHaveBeenCalledTimes(2);
      expect(command).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["docker", "podman"] as const)(
    "checks old and replacement runtime volumes through %s",
    async (engine) => {
      const list = vi.fn(async () => ({ exitCode: 0, stdout: "NAME CREATED PHASE\n", stderr: "" }));
      const command = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      await verifyExactCleanup(
        { command } as never,
        { list } as never,
        "mi-act-hermes",
        { NEMOCLAW_GATEWAY_RUNTIME: engine },
        ["old-id", "new-id", "new-id"],
      );
      expect(command.mock.calls.map((call) => call)).toEqual([
        [
          engine,
          ["ps", "-aq", "--filter", "label=openshell.ai/sandbox-name=mi-act-hermes"],
          expect.any(Object),
        ],
        [
          engine,
          ["volume", "ls", "-q", "--filter", "label=openshell.ai/sandbox-id=old-id"],
          expect.any(Object),
        ],
        [
          engine,
          ["volume", "ls", "-q", "--filter", "label=openshell.ai/sandbox-id=new-id"],
          expect.any(Object),
        ],
      ]);
    },
  );

  it.each(["old-id", "new-id"])("rejects a retained control volume for %s", async (retainedId) => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({ exitCode: 0, stdout: "NAME CREATED PHASE\n", stderr: "" }));
    const command = vi.fn(async (_engine: string, args: string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        args[0] === "volume" && args.at(-1) === `label=openshell.ai/sandbox-id=${retainedId}`
          ? `openshell-control-${retainedId}`
          : "",
    }));
    try {
      const assertion = expect(
        verifyExactCleanup({ command } as never, { list } as never, "mi-act-hermes", {}, [
          "old-id",
          "new-id",
        ]),
      ).rejects.toThrow(/exhausted/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { exitCode: 1, timedOut: false },
    { exitCode: 0, timedOut: true },
  ])("rejects an indeterminate runtime volume inventory %#", async (failure) => {
    const list = vi.fn(async () => ({ exitCode: 0, stdout: "NAME CREATED PHASE\n", stderr: "" }));
    const command = vi.fn(async (_engine: string, args: string[]) => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      ...(args[0] === "volume" ? failure : {}),
    }));
    await expect(
      verifyExactCleanup({ command } as never, { list } as never, "mi-act-hermes", {}, [
        "sandbox-1",
      ]),
    ).rejects.toThrow(/runtime volumes.*failed/);
  });

  it.each([{ ids: [] }, { ids: [""] }, { ids: ["one\ntwo"] }])(
    "rejects missing or ambiguous cleanup identities %#",
    async ({ ids }) => {
      const command = vi.fn();
      await expect(
        verifyExactCleanup({ command } as never, {} as never, "mi-act-hermes", {}, ids),
      ).rejects.toThrow(/observed runtime sandbox identities/);
      expect(command).not.toHaveBeenCalled();
    },
  );

  it.each(["docker", "podman"] as const)(
    "captures the runtime identity before cleanup through %s",
    async (engine) => {
      const command = vi.fn(async () => ({ exitCode: 0, stdout: "sandbox-1\n", stderr: "" }));
      await expect(
        inspectActivationSandboxId(
          { command } as never,
          "mi-act-hermes",
          {
            NEMOCLAW_GATEWAY_RUNTIME: engine,
          },
          "before-cleanup",
        ),
      ).resolves.toBe("sandbox-1");
      expect(command).toHaveBeenCalledWith(
        engine,
        [
          "ps",
          "-a",
          "--filter",
          "label=openshell.ai/sandbox-name=mi-act-hermes",
          "--filter",
          "label=openshell.ai/isolation-role=sandbox",
          "--format",
          '{{.Label "openshell.ai/sandbox-id"}}',
        ],
        expect.any(Object),
      );
    },
  );

  it("preserves runtime identity evidence before and after rebuild", async () => {
    const command = vi.fn(async () => ({ exitCode: 0, stdout: "sandbox-1\n", stderr: "" }));
    await inspectActivationSandboxId({ command } as never, "mi-act-hermes", {}, "before-rebuild");
    await inspectActivationSandboxId({ command } as never, "mi-act-hermes", {}, "after-rebuild");
    expect(
      command.mock.calls.map(
        (call) => (call as unknown as [string, string[], { artifactName: string }])[2].artifactName,
      ),
    ).toEqual([
      "activation-runtime-sandbox-id-mi-act-hermes-before-rebuild",
      "activation-runtime-sandbox-id-mi-act-hermes-after-rebuild",
    ]);
  });

  it.each(["", "one\ntwo", "<no value>"])(
    "rejects unusable runtime identity %j",
    async (stdout) => {
      const command = vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" }));
      await expect(
        inspectActivationSandboxId({ command } as never, "mi-act-hermes", {}, "before-cleanup"),
      ).rejects.toThrow(/must be unambiguous/);
    },
  );
});
