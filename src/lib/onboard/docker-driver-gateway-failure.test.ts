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
import { printOnboardResumeHint, resetOnboardResumeHintForTests } from "./resume-hint";
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
    resetOnboardResumeHintForTests();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Stub process.exit so assertions can still run.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints the 'failed to start' header and troubleshooting footer", () => {
    expect(() =>
      reportDockerDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
      }),
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
      { exitOnFailure: false, launchLogOffset: 0 },
    );
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).toContain("Gateway process exited with code 127 before becoming ready");
  });

  it("omits the child-exit line when the child is still running", () => {
    reportDockerDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
      exitOnFailure: false,
      launchLogOffset: 0,
    });
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).not.toContain("before becoming ready");
  });

  it("reports an unhealthy-within-timeout gateway without asserting liveness, and points at status commands (#5334)", () => {
    reportDockerDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
      exitOnFailure: false,
      launchLogOffset: 0,
    });
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).toContain("did not become healthy within the timeout");
    // Must not claim the process is still running: the caller can reach here
    // after liveness dropped before the 'exit' event fired (#5334 review).
    expect(joined).not.toContain("still running");
    expect(joined).toContain("openshell status");
    expect(joined).toContain("openshell gateway info");
  });

  it("prefers the specific exit description over the generic line when the gateway exited (#5334)", () => {
    reportDockerDriverGatewayStartFailure(
      "/tmp/nonexistent-gateway.log",
      makeExitState({ exited: true, code: 1, describeExit: () => "exited with code 1" }),
      { exitOnFailure: false, launchLogOffset: 0 },
    );
    const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
    expect(joined).toContain("exited with code 1");
    expect(joined).not.toContain("did not become healthy within the timeout");
  });

  it("includes a tail of the gateway log when the file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(log, ["line-a", "line-b", "", "line-c", "GLIBC_2.38 not found"].join("\n"));
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("Gateway log tail");
      expect(joined).toContain("GLIBC_2.38 not found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints Docker runtime recovery guidance when gateway log shows Docker is unreachable (#2347)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      ["Error: Failed to create Docker client.", "Socket not found: /var/run/docker.sock"].join(
        "\n",
      ),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("Start Docker, then rerun `nemoclaw onboard`");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a shell-quoted state-directory move after confirming no gateway process remains (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const stateDir = path.join(dir, "gateway state;echo it's ignored");
    const log = path.join(stateDir, "openshell-gateway.log");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      log,
      [
        "Error: execution error: migration error: migration 6 was previously applied",
        "  is missing in the resolved migrations",
      ].join("\n"),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState({ exited: true }), {
        exitOnFailure: false,
        isGatewayStateInUse: () => false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => "systemctl --user stop nemoclaw-openshell-gateway",
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("cannot use the existing gateway database");
      expect(joined).toContain(`Database: ${path.join(stateDir, "openshell.db")}`);
      expect(joined).toContain("it'\\''s ignored'");
      expect(joined).toContain("it'\\''s ignored.incompatible'");
      expect(joined).toContain("contains credentials and all registrations");
      expect(joined).toContain("mkdir -m 700");
      expect(joined).toContain("incompatible/gateway-state'");
      expect(joined).toContain("nemoclaw onboard --resume");
      expect(joined).toContain("systemctl --user stop nemoclaw-openshell-gateway && mkdir -m 700");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recommend moving gateway state for an unrelated SQLite error (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(log, "database is locked while applying migration 6\n");
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).not.toContain("cannot use the existing gateway database");
      expect(joined).not.toContain(".incompatible");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a migration signature written before the current gateway launch (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    const previousLaunch = [
      "migration 6 was previously applied",
      "is missing in the resolved migrations",
      "",
    ].join("\n");
    fs.writeFileSync(log, `${previousLaunch}current launch failed for another reason\n`);
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState({ exited: true }), {
        exitOnFailure: false,
        launchLogOffset: Buffer.byteLength(previousLaunch),
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("current launch failed for another reason");
      expect(joined).not.toContain("cannot use the existing gateway database");
      expect(joined).not.toContain(".incompatible");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: NemoClaw #8797. On the reported downgrade the gateway dies on
  // this failure, but the start loop reports it after the poll budget expires,
  // so `childExit.exited` is false. Withholding the diagnosis in that state
  // left the reported path with the raw sqlx text and no remedy.
  it("prints the managed-service stop ahead of the state move when the exit was not observed (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      [
        "Starting OpenShell server bind=127.0.0.1:8080",
        "Error:   × execution error: migration error: migration 6 was previously applied but",
        "  │ is missing in the resolved migrations",
      ].join("\n"),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => "systemctl --user stop nemoclaw-openshell-gateway",
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("did not become healthy within the timeout");
      expect(joined).toContain("cannot use the existing gateway database");
      expect(joined).toContain(`Database: ${path.join(dir, "openshell.db")}`);
      expect(joined).toContain(
        `systemctl --user stop nemoclaw-openshell-gateway && mkdir -m 700 '${dir}.incompatible'`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The recovery must stop the manager that actually runs the gateway on this
  // host, so macOS gets the Homebrew service (#8797).
  it("stops the Homebrew service in the recovery on macOS (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      [
        "Error:   × execution error: migration error: migration 6 was previously applied but",
        "  │ is missing in the resolved migrations",
      ].join("\n"),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => "brew services stop openshell",
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("brew services stop openshell && mkdir -m 700");
      expect(joined).not.toContain("systemctl --user stop");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["a replacement still uses the selected state", () => true],
    ["no identity-aware liveness result is available", undefined],
  ] as const)("withholds the standalone state move when %s (#8797)", (_scenario, probe) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      [
        "Error:   × execution error: migration error: migration 6 was previously applied but",
        "  │ is missing in the resolved migrations",
      ].join("\n"),
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        isGatewayStateInUse: probe,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => null,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("could not confirm that the standalone gateway process stopped");
      expect(joined).not.toContain(`mkdir -m 700 '${dir}.incompatible'`);
      expect(joined).not.toContain("systemctl --user stop");
      expect(joined).not.toContain("brew services stop");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the stop for a confirmed-unused standalone gateway (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      "migration 6 was previously applied and is missing in the resolved migrations\n",
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState(), {
        exitOnFailure: false,
        isGatewayStateInUse: () => false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => null,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain(`mkdir -m 700 '${dir}.incompatible'`);
      expect(joined).not.toContain("systemctl --user stop");
      expect(joined).not.toContain("brew services stop");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selects a second archive path when the first archive path exists (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const stateDir = path.join(dir, "gateway");
    const log = path.join(stateDir, "openshell-gateway.log");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(`${stateDir}.incompatible`);
    fs.writeFileSync(
      log,
      "migration 6 was previously applied and is missing in the resolved migrations\n",
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState({ exited: true }), {
        exitOnFailure: false,
        isGatewayStateInUse: () => false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => null,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain(`mkdir -m 700 '${stateDir}.incompatible-2'`);
      expect(joined).toContain(`'${stateDir}.incompatible-2/gateway-state'`);
      expect(joined).not.toContain(`mkdir -m 700 '${stateDir}.incompatible' &&`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not offer onboarding when no gateway-state archive path is available (#8797)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const stateDir = path.join(dir, "gateway");
    const log = path.join(stateDir, "openshell-gateway.log");
    fs.mkdirSync(stateDir);
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      fs.mkdirSync(`${stateDir}.incompatible${suffix === 1 ? "" : `-${suffix}`}`);
    }
    fs.writeFileSync(
      log,
      "migration 6 was previously applied and is missing in the resolved migrations\n",
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState({ exited: true }), {
        exitOnFailure: false,
        isGatewayStateInUse: () => false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => null,
      });
      printOnboardResumeHint(false, console.error);
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("could not select an unused archive path");
      expect(joined).toContain("Keep the gateway stopped");
      expect(joined).not.toContain("nemoclaw onboard");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints fresh portable onboarding instead of resume for incompatible database recovery (#8797)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-fail-"));
    const log = path.join(dir, "openshell-gateway.log");
    fs.writeFileSync(
      log,
      "migration 6 was previously applied and is missing in the resolved migrations\n",
    );
    try {
      reportDockerDriverGatewayStartFailure(log, makeExitState({ exited: true }), {
        exitOnFailure: false,
        isGatewayStateInUse: () => false,
        launchLogOffset: 0,
        resolveGatewayStopCommand: () => null,
      });
      const joined = errSpy.mock.calls.map((c: string[]) => c.join(" ")).join("\n");
      expect(joined).toContain("nemoclaw onboard --experimental-profile portable --fresh");
      expect(joined).not.toContain("nemoclaw onboard --resume");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls process.exit(1) when exitOnFailure is true", () => {
    expect(() =>
      reportDockerDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
        exitOnFailure: true,
        launchLogOffset: 0,
      }),
    ).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does NOT call process.exit when exitOnFailure is false", () => {
    reportDockerDriverGatewayStartFailure("/tmp/nonexistent-gateway.log", makeExitState(), {
      exitOnFailure: false,
      launchLogOffset: 0,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
