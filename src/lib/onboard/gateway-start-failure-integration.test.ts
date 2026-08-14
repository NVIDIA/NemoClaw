// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the docker-unreachable abort path the Docker-driver
// gateway start takes when the gateway log reports the Docker daemon is not
// reachable.
//
// This helper-level suite preserves the former shell regression, which was
// structurally a Node-process unit test of startGateway() with a PATH-shimmed
// openshell binary, not a sandbox-lifecycle E2E.
//
// Original regression: NemoClaw #2347.
// Owning migration issue: NemoClaw #4355.
//
// Coverage strategy: prove the exported helper contract here. The production
// Docker-driver composition is exercised through
// docker-driver-gateway-failure.test.ts instead of copying its control flow
// into this test.

import { describe, expect, it, vi } from "vitest";
import {
  createFinalGatewayStartFailureHandler,
  printDockerDaemonRecovery,
} from "./gateway-start-failure";

// The production binding itself remains covered by
// test/gateway-final-failure-cleanup.test.ts. These helper checks only need the
// production factory, and should not load onboard.ts's
// full dependency graph for every source-test worker.
const handleFinalGatewayStartFailure = createFinalGatewayStartFailureHandler({
  getGatewayName: () => "nemoclaw",
  collectDiagnostics: () => "",
  cleanupGateway: () => undefined,
});

describe("startGatewayWithOptions docker-unreachable abort (#2347)", () => {
  // ── Layer 1: unit tests of the platform-branching recovery message ────────

  describe("printDockerDaemonRecovery platform branches", () => {
    it("prints the macOS/colima recovery hint when platform=darwin", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "darwin");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("colima start");
      expect(joined).not.toContain("systemctl");
    });

    it("prints the Linux/systemctl recovery hint when platform=linux", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "linux");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("sudo systemctl start docker");
      expect(joined).not.toContain("colima start");
    });

    it("prints a platform-neutral fallback hint on other platforms", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "win32");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("Start the Docker daemon");
      expect(joined).not.toContain("colima start");
      expect(joined).not.toContain("systemctl");
    });

    it("prints the rootless-Podman resume hint when portable=true (#9035)", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "linux", true);
      const joined = printed.join("\n");
      expect(joined).toContain("rootless Podman API service is not reachable");
      expect(joined).toContain("Start Podman");
      expect(joined).toContain("nemoclaw onboard --resume");
      expect(joined).not.toContain("nemoclaw onboard --experimental-profile portable");
      expect(joined).not.toContain("sudo systemctl start docker");
      expect(joined).not.toContain("colima start");
      expect(joined).toContain("--resume");
    });
  });

  // ── Layer 1: handleFinalGatewayStartFailure dockerUnreachable branch ─────
  //
  // Proves three things at once:
  //   - exitProcess(1) is called → covers the legacy script's NODE_EXIT==1
  //     assertion.
  //   - collectDiagnostics is NEVER called → covers the legacy script's
  //     `!grep "openshell doctor logs"` assertion (the script's assertion 7).
  //   - cleanupGateway is NEVER called → covers the legacy script's implicit
  //     contract that destroyGateway is not invoked on Docker-unreachable
  //     (preserving any prior good gateway state for the user).
  //   - printError is invoked with the recovery guidance → composition with
  //     printDockerDaemonRecovery.

  describe("handleFinalGatewayStartFailure({dockerUnreachable: true})", () => {
    it("calls exitProcess(1) and skips diagnostics + cleanup", () => {
      const printError = vi.fn();
      const collectDiagnostics = vi.fn(() => "should-never-be-collected");
      const cleanupGateway = vi.fn();
      const exitProcess = vi.fn((code: number) => {
        // Throw so the function's `: never` signature is honored from the
        // test's perspective without actually terminating the process.
        throw new Error(`__exitProcess(${code})`);
      }) as (code: number) => never;

      expect(() =>
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: true,
          printError,
          collectDiagnostics,
          cleanupGateway,
          exitProcess,
        }),
      ).toThrow(/__exitProcess\(1\)/);

      expect(exitProcess).toHaveBeenCalledTimes(1);
      expect(exitProcess).toHaveBeenCalledWith(1);
      // The crucial behavioural difference from the non-Docker-unreachable
      // path: no doctor logs are collected and no cleanup is attempted.
      expect(collectDiagnostics).not.toHaveBeenCalled();
      expect(cleanupGateway).not.toHaveBeenCalled();

      const printed = printError.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(printed).toContain("Docker daemon is not running");
    });

    it("DOES collect diagnostics and clean up when dockerUnreachable=false (negative control)", () => {
      // Guards against a future refactor that accidentally short-circuits the
      // non-Docker-unreachable branch as well.
      const printError = vi.fn();
      const collectDiagnostics = vi.fn(() => "");
      const cleanupGateway = vi.fn();
      const exitProcess = vi.fn(() => {
        throw new Error("__exitProcess");
      }) as (code: number) => never;

      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: false,
          printError,
          collectDiagnostics,
          cleanupGateway,
          exitProcess,
        });
      } catch {
        // expected — handleFinal still calls exitProcess on the unhealthy
        // (non-Docker-unreachable) branch by way of the surrounding caller;
        // here the function returns normally if exitProcess does not throw.
      }

      expect(collectDiagnostics).toHaveBeenCalled();
      expect(cleanupGateway).toHaveBeenCalled();
    });
  });

});
