// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runJetsonOpenRmProcessProof } from "./jetson-openrm-process-proof";

function modeFromArgs(args: readonly string[]): string {
  return args.at(-1) ?? "";
}

describe("Jetson OpenRM process proof", () => {
  it("isolates a non-seccomp process control before syscall probes (#7610)", () => {
    const dockerRun = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout: `cuInit(0)=${modeFromArgs(args) === "nondumpable" ? "801" : "0"}`,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runJetsonOpenRmProcessProof("a".repeat(64), dockerRun);

    expect(dockerRun).toHaveBeenCalledTimes(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("nondumpable"));
  });

  it("isolates one OpenShell blocked syscall after the fixed process cases pass (#7610)", () => {
    const dockerRun = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout: `cuInit(0)=${["openshell-seccomp", "deny-process_vm_readv"].includes(modeFromArgs(args)) ? "801" : "0"}`,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runJetsonOpenRmProcessProof("b".repeat(64), dockerRun);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("CUDA-required rule(s): process_vm_readv"),
    );
    expect(dockerRun.mock.calls.some(([args]) => modeFromArgs(args) === "deny-clone3")).toBe(true);
    expect(
      dockerRun.mock.calls.some(([args]) => modeFromArgs(args) === "deny-socket-netlink-non-route"),
    ).toBe(true);
  });

  it("isolates an interaction with the complete OpenShell seccomp filter (#7610)", () => {
    const dockerRun = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout: `cuInit(0)=${modeFromArgs(args).includes("nondumpable-plus") || modeFromArgs(args) === "hardening-plus-openshell-seccomp" ? "801" : "0"}`,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runJetsonOpenRmProcessProof("c".repeat(64), dockerRun);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("seccomp is combined with nondumpable"),
    );
  });

  it("reports an invalid direct-Docker baseline without testing syscall denials (#7610)", () => {
    const dockerRun = vi.fn(() => ({ status: 1, stdout: "cuInit(0)=801" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    runJetsonOpenRmProcessProof("d".repeat(64), dockerRun);

    expect(dockerRun).toHaveBeenCalledTimes(7);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("baseline did not pass"));
  });
});
