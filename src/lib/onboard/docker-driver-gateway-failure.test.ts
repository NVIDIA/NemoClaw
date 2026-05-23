// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for reportDockerDriverGatewayStartFailure.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3111

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChildExitState } from "./child-exit-tracker";
import { reportDockerDriverGatewayStartFailure } from "./docker-driver-gateway-failure";

function makeExitState(partial: Partial<ChildExitState> = {}): ChildExitState {
  return {
    exited: false,
    code: null,
    signal: null,
    describeExit: () => null,
    ...partial,
  } as ChildExitState;
}

describe("reportDockerDriverGatewayStartFailure (#3111)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Stub process.exit so assertions can still run.
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
  });

  afterEach(() => {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints the 'failed to start' header and troubleshooting footer", () => {
    expect(() =>
      reportDockerDriverGatewayStartFailure(
        "/tmp/nonexistent-gateway.log",
        makeExitState(),
        { exitOnFailure: false },
      ),
    ).not.toThrow();
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).toContain("Docker-driver gateway failed to start");
    expect(joined).toContain("Troubleshooting:");
    expect(joined).toContain("tail -100 /tmp/nonexistent-gateway.log");
    expect(joined).toContain("docker info");
  });

  it("surfaces the child exit description when the child has exited", () => {
    reportDockerDriverGatewayStartFailure(
      "/tmp/nonexistent-gateway.log",
      makeExitState({
        exited: true,
        code: 127,
        describeExit: () => "exited with code 127",
      }),
      { exitOnFailure: false },
    );
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).toContain(
      "Gateway process exited with code 127 before becoming ready",
    );
  });

  it("omits the child-exit line when the child is still running", () => {
    reportDockerDriverGatewayStartFailure(
      "/tmp/nonexistent-gateway.log",
      makeExitState(),
      { exitOnFailure: false },
    );
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).not.toContain("before becoming ready");
  });

  it("includes a tail of the gateway log when the file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      ["line-a", "line-b", "", "line-c", "GLIBC_2.38 not found"].join("\n"),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("Gateway log tail");
      expect(joined).toContain("GLIBC_2.38 not found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls process.exit(1) when exitOnFailure is true", () => {
    expect(() =>
      reportDockerDriverGatewayStartFailure(
        "/tmp/nonexistent-gateway.log",
        makeExitState(),
        { exitOnFailure: true },
      ),
    ).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does NOT call process.exit when exitOnFailure is false", () => {
    reportDockerDriverGatewayStartFailure(
      "/tmp/nonexistent-gateway.log",
      makeExitState(),
      { exitOnFailure: false },
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
