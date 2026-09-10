// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const { spawn, docker } = vi.hoisted(() => ({ spawn: vi.fn(), docker: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("../docker/exec", () => ({ dockerSpawnSync: docker }));

import { defaultRun, defaultRunDocker } from "./commands";

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
