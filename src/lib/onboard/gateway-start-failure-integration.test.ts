// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the docker-unreachable abort path that
// startGatewayWithOptions() takes when `openshell gateway start` reports
// the Docker daemon is not reachable. See src/lib/onboard.ts:2233.
//
// This file replaces test/e2e/test-docker-unreachable-gateway-start.sh,
// which was structurally a Node-process unit test of startGateway() with a
// PATH-shimmed openshell binary, not a sandbox-lifecycle e2e.
//
// Original regression: NemoClaw #2347.
// Owning migration issue: NemoClaw #4355.
//
// Coverage strategy: prove the contract through two layers:
//
//   1. Unit tests of the already-exported helpers (printDockerDaemonRecovery,
//      handleFinalGatewayStartFailure with dockerUnreachable=true).
//   2. A composition test that runs the same helper sequence the call site
//      uses (classify → handleFinal → exitProcess(1)).
//
// Caller-level (process-level) coverage of the #2347 contracts already
// exists in test/onboard.test.ts:
//
//   it("fast-fails gateway start before health polling when Docker is
//      unreachable (#2347)", ...)
//
// That test spawns a child Node process with a PATH-shimmed openshell
// binary returning the Docker socket-not-found signature, mocks p-retry,
// loads the compiled startGateway() from dist/lib/onboard.js, and
// asserts: exit code 1, "Docker daemon is not running" in stderr, the
// "colima start" macOS hint, NO "Waiting for gateway health...", and NO
// post-start status/gateway-info probe output. Together with the helper
// + composition tests in this file, those caller-level contracts are
// fully covered.
//
// The remaining narrow gap (one it.todo below) is direct evidence that
// dockerUnreachable=true is forwarded to handleFinalGatewayStartFailure
// SPECIFICALLY (vs some other exit path that also yields exit 1) — the
// distinguishing wire-format signal would be the absence of "Cleaning
// up failed gateway state..." output that the non-Docker-unreachable
// branch prints. test/onboard.test.ts does not grep for that absence.
// Closing that narrow gap is tracked in follow-up issue #5113.

import { describe, expect, it, vi } from "vitest";
// `handleFinalGatewayStartFailure` is exposed via `module.exports = {...}` at
// the bottom of onboard.ts (it is not a TypeScript `export`). Import the
// compiled output (same approach as preflight.test.ts and other onboard-
// adjacent tests) so the CommonJS `require()` calls in onboard.ts and its
// transitive dependencies resolve cleanly under Vitest. Coverage also lands
// on dist/lib/onboard.js, matching what the coverage ratchet measures.
import onboardExports from "../../../dist/lib/onboard";
import { classifyGatewayStartFailure } from "../validation";
import {
  printDockerDaemonRecovery,
  reportLegacyGatewayStartResultFailure,
} from "./gateway-start-failure";

const handleFinalGatewayStartFailure: (opts: {
  retries: number;
  dockerUnreachable?: boolean;
  collectDiagnostics?: () => string;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
}) => never = (onboardExports as unknown as Record<string, unknown>)
  .handleFinalGatewayStartFailure as never;

// Real signatures the legacy script's fake openshell binary emitted from
// `gateway start` to simulate Colima-stopped (macOS) and dockerd-stopped
// (Linux). These are the wire format the call site sees from
// streamGatewayStart()'s `output` field.
const DARWIN_DOCKER_UNREACHABLE_OUTPUT = [
  "Error: Failed to create Docker client.",
  "Socket not found: /var/run/docker.sock",
].join("\n");

const LINUX_DOCKER_UNREACHABLE_OUTPUT =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

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

  // ── Layer 2: composition test — the exact sequence the call site uses ────
  //
  // startGatewayWithOptions does, on `streamGatewayStart()` failure:
  //
  //     const failure = reportLegacyGatewayStartResultFailure(output, log);
  //     if (failure.kind === "docker_unreachable") {
  //       dockerUnreachable = true;
  //       throw new pRetry.AbortError(...);
  //     }
  //   } catch {
  //     if (exitOnFailure) {
  //       handleFinalGatewayStartFailure({ retries, dockerUnreachable });
  //     }
  //     throw new Error("Gateway failed to start");
  //   }
  //
  // The composition test exercises the same helpers in the same order and
  // confirms the chain bottoms out at exitProcess(1) with the recovery
  // message printed.

  describe("composition: classify → handleFinal → exit 1", () => {
    let capturedClassifyLog: string[];
    let capturedPrintError: string[];

    function runComposition(streamGatewayStartOutput: string): {
      thrown: unknown;
      exitCode: number | null;
    } {
      capturedClassifyLog = [];
      capturedPrintError = [];

      const failure = reportLegacyGatewayStartResultFailure(streamGatewayStartOutput, (m) =>
        capturedClassifyLog.push(m),
      );

      let dockerUnreachable = false;
      if (failure.kind === "docker_unreachable") {
        dockerUnreachable = true;
      }

      let exitCode: number | null = null;
      let thrown: unknown = null;
      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable,
          printError: (m = "") => capturedPrintError.push(m),
          collectDiagnostics: () => {
            throw new Error("collectDiagnostics must not be called on docker_unreachable");
          },
          cleanupGateway: () => {
            throw new Error("cleanupGateway must not be called on docker_unreachable");
          },
          exitProcess: ((code: number) => {
            exitCode = code;
            throw new Error(`__exit(${code})`);
          }) as (code: number) => never,
        });
      } catch (err) {
        thrown = err;
      }
      return { thrown, exitCode };
    }

    it("composes through the docker-unreachable path on the macOS Colima signature", () => {
      const { thrown, exitCode } = runComposition(DARWIN_DOCKER_UNREACHABLE_OUTPUT);
      expect(thrown).toBeInstanceOf(Error);
      expect(exitCode).toBe(1);
      expect(capturedPrintError.join("\n")).toContain("Docker daemon is not running");
      // The classification helper logs the original output as a breadcrumb;
      // the legacy script asserts on this output too via its `[INFO] node
      // exit code` log lines.
      expect(capturedClassifyLog.join("\n")).toContain("Gateway start returned before healthy");
    });

    it("composes through the docker-unreachable path on the Linux dockerd signature", () => {
      const { thrown, exitCode } = runComposition(LINUX_DOCKER_UNREACHABLE_OUTPUT);
      expect(thrown).toBeInstanceOf(Error);
      expect(exitCode).toBe(1);
      expect(capturedPrintError.join("\n")).toContain("Docker daemon is not running");
    });

    it("does NOT trigger the docker-unreachable path on unrelated start output (negative control)", () => {
      // A genuinely-broken-but-not-Docker-unreachable failure must still reach
      // the regular failure path (which DOES collect diagnostics and clean
      // up). If this test ever flips, the call-site classifier has been made
      // too aggressive and would silence real gateway failures behind the
      // Docker-recovery message.
      capturedClassifyLog = [];
      capturedPrintError = [];

      const failure = reportLegacyGatewayStartResultFailure(
        "  k3s: failed to bootstrap helm chart after 90s\n",
        (m) => capturedClassifyLog.push(m),
      );

      expect(failure.kind).toBe("unknown");

      let collectCalls = 0;
      let cleanupCalls = 0;
      let exitCode: number | null = null;
      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: false,
          printError: (m = "") => capturedPrintError.push(m),
          collectDiagnostics: () => {
            collectCalls += 1;
            return "";
          },
          cleanupGateway: () => {
            cleanupCalls += 1;
          },
          exitProcess: ((code: number) => {
            exitCode = code;
            throw new Error(`__exit(${code})`);
          }) as (code: number) => never,
        });
      } catch {
        // expected
      }
      expect(collectCalls).toBeGreaterThan(0);
      expect(cleanupCalls).toBeGreaterThan(0);
      // The non-Docker-unreachable branch does NOT print the Docker daemon
      // recovery message.
      expect(capturedPrintError.join("\n")).not.toContain("Docker daemon is not running");
      // exitCode is left null here because the test's exitProcess throws
      // and the surrounding handleFinal swallows other branches' exits via
      // its caller — the assertion that matters is that diagnostics + cleanup
      // happened.
      void exitCode;
    });
  });

  // ── Narrow remaining gap: distinguish dockerUnreachable=true from other
  //    exit-1 paths via cleanup-messaging absence ───────────────────────
  //
  // test/onboard.test.ts:"fast-fails gateway start before health polling
  // when Docker is unreachable (#2347)" already proves at the process
  // level: exit 1, recovery guidance printed, no health-poll loop entry,
  // and no status/gateway-info probes. What it does NOT directly assert
  // is that handleFinalGatewayStartFailure was called with
  // dockerUnreachable=true SPECIFICALLY — the distinguishing signal is
  // the absence of the "Cleaning up failed gateway state..." line that
  // the alternative branch prints. Asserting on that absence requires
  // either extending test/onboard.test.ts or extracting attemptGatewayStart
  // per follow-up issue
  // [#5113](https://github.com/NVIDIA/NemoClaw/issues/5113).

  describe("call-site contracts (narrow remaining gap)", () => {
    it.todo(
      "on docker-unreachable streamGatewayStart output, handleFinalGatewayStartFailure is invoked with dockerUnreachable=true (proven by absence of 'Cleaning up failed gateway state...' in output, vs the non-docker-unreachable branch that prints it)",
    );
  });

  // ── Sanity: classifyGatewayStartFailure recognises both signatures ─────
  // (Already covered in gateway-start-failure.test.ts; this is a pinning
  // assertion for the two strings the legacy script generated, kept here so
  // the retirement leaves no implicit reference to those byte sequences.)

  describe("classifyGatewayStartFailure pinning for legacy-script signatures", () => {
    it("classifies the macOS Colima signature as docker_unreachable", () => {
      expect(classifyGatewayStartFailure(DARWIN_DOCKER_UNREACHABLE_OUTPUT)).toEqual({
        kind: "docker_unreachable",
      });
    });

    it("classifies the Linux dockerd signature as docker_unreachable", () => {
      expect(classifyGatewayStartFailure(LINUX_DOCKER_UNREACHABLE_OUTPUT)).toEqual({
        kind: "docker_unreachable",
      });
    });
  });
});
