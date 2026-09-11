// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const { spawn, docker } = vi.hoisted(() => ({ spawn: vi.fn(), docker: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("../docker/exec", () => ({ dockerSpawnSync: docker }));

import { defaultRun, defaultRunDocker, createUninstallProviderAdapter } from "./commands";

describe("uninstall host command execution", () => {
  it("preserves command arguments, environment, and captured output", () => {
    spawn.mockReturnValue({ status: 7, stdout: "out", stderr: Buffer.from("err") });
    const env = { PATH: "/trusted/bin" };
    expect(defaultRun("openshell", ["provider", "list"], { env })).toEqual({
      status: 7,
      stdout: "out",
      stderr: "err",
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith("openshell", ["provider", "list"], {
      encoding: "utf-8",
      env,
    });
  });

  it("uses the Docker boundary and preserves uncertain exit status", () => {
    docker.mockReturnValue({ status: null, stdout: null, stderr: undefined });
    expect(defaultRunDocker(["inspect", "owned"], { encoding: "buffer" })).toEqual({
      status: null,
      stdout: "",
      stderr: "",
    });
    expect(docker).toHaveBeenCalledExactlyOnceWith(["inspect", "owned"], {
      encoding: "buffer",
    });
  });
});

it("binds provider deletion to the uninstall environment and preserves uncertainty", async () => {
  const env = { HOME: "/home/uninstall", OPENSHELL_GATEWAY: "owned-gateway" };
  const run = vi.fn(() => ({ status: null, stdout: "", stderr: "connection reset" }));
  const adapter = createUninstallProviderAdapter(run, env);
  await expect(
    adapter.deleteProvider({ target: { kind: "selected" }, providerName: "nvidia-nim" }),
  ).resolves.toMatchObject({ ok: false, error: { kind: "command", reason: "uncertain" } });
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "openshell",
    ["provider", "delete", "nvidia-nim"],
    expect.objectContaining({ env }),
  );
});

it.each([
  ["ETIMEDOUT", { kind: "timeout" }],
  ["ENOENT", { kind: "transport", reason: "process_start" }],
  ["EACCES", { kind: "transport", reason: "process_start" }],
])(
  "preserves %s from the uninstall subprocess through provider classification",
  async (code, error) => {
    spawn.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error(code), { code }),
    });
    const adapter = createUninstallProviderAdapter(defaultRun, {});
    await expect(
      adapter.deleteProvider({ target: { kind: "selected" }, providerName: "nvidia-nim" }),
    ).resolves.toMatchObject({ ok: false, error });
  },
);

it("preserves a signal so interrupted detach cannot look idempotent", async () => {
  spawn.mockReturnValue({ status: 1, stdout: "NotAttached", stderr: "", signal: "SIGTERM" });
  const adapter = createUninstallProviderAdapter(defaultRun, {});
  await expect(
    adapter.detachProvider({
      target: { kind: "selected" },
      providerName: "nvidia-nim",
      sandboxName: "alpha",
    }),
  ).resolves.toMatchObject({ ok: false });
});
