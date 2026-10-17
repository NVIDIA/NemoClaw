// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { bootstrapCleanupHarness, cleanupResult as result } from "./hosted-cleanup-harness.ts";
import { cleanupBootstrapState, sandboxAbsentFromList } from "../live/hosted-e2e-cleanup.ts";

describe("hosted sandbox absence", () => {
  it.each([
    ["[]", true],
    ['[{"name":"another-sandbox"}]', true],
    ['[{"name":"target"}]', false],
    ['[{"id":"unknown"}]', false],
    ["[null]", false],
    ["{}", false],
    ["Not configured", false],
  ] as const)("interprets sandbox list %s as absence %s", (output, absent) => {
    expect(sandboxAbsentFromList(result(output), "target")).toBe(absent);
  });
  it.each([{ exitCode: 1 }, { timedOut: true }, { signal: "SIGTERM" as const }])(
    "rejects an unsuccessful list with status %j",
    (status) => {
      expect(sandboxAbsentFromList(result("[]", status), "target")).toBe(false);
    },
  );
});

describe("bootstrap teardown", () => {
  it("completes all cleanup operations", async () => {
    const { input, events } = bootstrapCleanupHarness();
    await expect(cleanupBootstrapState(input)).resolves.toBeUndefined();
    expect(events).toEqual(["destroy", "delete", "gateway", "clone"]);
  });
  it.each(["destroy", "delete", "gateway", "clone"])(
    "attempts every cleanup and reports %s failure",
    async (failure) => {
      const { input, events } = bootstrapCleanupHarness(failure);
      await expect(cleanupBootstrapState(input)).rejects.toThrow("Bootstrap cleanup failed");
      expect(events).toEqual(["destroy", "delete", "gateway", "clone"]);
    },
  );
  it.each([1, 127])("removes the clone when missing CLIs return exit %s", async (exitCode) => {
    const command = vi.fn(async (executable: string) =>
      result("", { exitCode: executable === "sh" ? exitCode : 0 }),
    );
    const cleanupGatewayRegistration = vi.fn();
    await cleanupBootstrapState({
      host: { command, cleanupGatewayRegistration } as unknown as HostCliClient,
      sandbox: {} as SandboxClient,
      name: "target",
      cloneDir: "/tmp/task-owned-clone",
      env: {},
    });
    expect(command).toHaveBeenLastCalledWith(
      "bash",
      expect.arrayContaining(["/tmp/task-owned-clone"]),
      expect.any(Object),
    );
    expect(cleanupGatewayRegistration).not.toHaveBeenCalled();
  });
  it.each([
    { exitCode: 127, stderr: "cannot start shell" },
    { exitCode: 1, stderr: "lookup failed" },
    { exitCode: 127, stdout: "unexpected output" },
    { exitCode: 127, timedOut: true },
    { exitCode: 127, signal: "SIGTERM" as const },
    { exitCode: 2 },
  ])("reports unsuccessful CLI inspection %j and still removes the clone", async (status) => {
    const { input, events } = bootstrapCleanupHarness("none", result("", status));
    await expect(cleanupBootstrapState(input)).rejects.toThrow("Bootstrap cleanup failed");
    expect(events).toEqual(["clone"]);
  });
});
