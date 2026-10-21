// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  capturePortableRegistryProcessBoundary,
  collectPortableRegistryReadinessFailure,
  probePortableRegistry,
  runPortableRegistryReadinessPolicy,
  type PortableRegistryReadinessObservation,
} from "../fixtures/portable-registry-readiness.ts";
import type {
  ShellProbe,
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portable registry readiness policy", () => {
  it("records the inherited finite service process boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-registry-boundary-"));
    const evidence = {
      schemaVersion: 1 as const,
      minimumHeadroom: 128,
      inheritedServiceBoundary: true,
      service: { cgroup: "/service", tasksMax: 71707, tasksCurrent: 21 },
      registry: { cgroup: "/service" },
      cgroup: { pidsMax: 71707, pidsCurrent: 22 },
    };
    const run = vi.fn(
      async (
        _command: TrustedShellCommand,
        _options: ShellProbeRunOptions,
      ): Promise<ShellProbeResult> => ({
        command: [],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify(evidence),
        stderr: "",
        artifacts: { stdout: "", stderr: "", result: "" },
      }),
    );
    try {
      vi.stubEnv("DOCKER_HOST", "unix:///run/user/1000/podman/podman.sock");
      const result = await capturePortableRegistryProcessBoundary({
        artifacts: new ArtifactSink(root),
        shellProbe: { run } as unknown as ShellProbe,
      });

      expect(result).toEqual(evidence);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(root, "portable-registry-process-boundary.json"), "utf8"),
        ),
      ).toEqual(evidence);
      const [command, options] = run.mock.calls[0]!;
      expect(command.args[5]).toContain('[[ $registry_group == "$service_group" ]]');
      expect(command.args[5]).toContain('[[ $cgroup_max == "$tasks_max" ]]');
      expect(command.args[5]).toContain("(( cgroup_max - cgroup_current >= minimum ))");
      expect(command.args[5]).toContain("fail_boundary service-headroom-insufficient");
      expect(options.env).not.toHaveProperty("UNRELATED_API_KEY");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable effective process boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-registry-boundary-"));
    const run = vi.fn(
      async (
        _command: TrustedShellCommand,
        _options: ShellProbeRunOptions,
      ): Promise<ShellProbeResult> => ({
        command: [],
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ failureReason: "service-headroom-insufficient" }),
        stderr: "registry cgroup mismatch",
        artifacts: { stdout: "", stderr: "", result: "" },
      }),
    );
    try {
      await expect(
        capturePortableRegistryProcessBoundary({
          artifacts: new ArtifactSink(root),
          shellProbe: { run } as unknown as ShellProbe,
        }),
      ).rejects.toThrow(
        "Portable registry process-boundary verification failed: service-headroom-insufficient.",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records first-attempt readiness without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const onEvidence = vi.fn();

    const result = await runPortableRegistryReadinessPolicy({
      probe: async () => ({ kind: "ready", statusCode: 200 }),
      sleep,
      onEvidence,
    });

    expect(result.outcome).toBe("passed");
    expect(result.evidence.outcome).toBe("passed-first-attempt");
    expect(result.evidence.attempts).toEqual([
      { attempt: 1, outcome: "passed", retryScheduled: false },
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(result.evidence);
  });

  it("retries only the named transport startup failures", async () => {
    const observations: PortableRegistryReadinessObservation[] = [
      { kind: "transport", code: "connection-refused" },
      { kind: "transport", code: "connection-reset" },
      { kind: "ready", statusCode: 200 },
    ];
    const probe = vi.fn(async () => observations.shift()!);
    const sleep = vi.fn(async () => {});

    const result = await runPortableRegistryReadinessPolicy({ probe, sleep, delayMs: 25 });

    expect(result.outcome).toBe("passed");
    expect(result.evidence.outcome).toBe("passed-after-retry");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      { attempt: 3, outcome: "passed", retryScheduled: false },
    ]);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
  });

  it.each([
    { kind: "http-status", statusCode: 503 } as const,
    { kind: "transport", code: "unexpected" } as const,
  ])("stops without retrying a deterministic $kind failure", async (observation) => {
    const probe = vi.fn(async () => observation);
    const sleep = vi.fn(async () => {});

    const result = await runPortableRegistryReadinessPolicy({ probe, sleep });

    expect(result.outcome).toBe("failed");
    expect(result.value).toEqual(observation);
    expect(result.evidence.outcome).toBe("failed-no-retry");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "deterministic",
        retryScheduled: false,
      },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retains exhausted timeout attempt evidence", async () => {
    const onEvidence = vi.fn();
    const result = await runPortableRegistryReadinessPolicy({
      probe: async () => ({ kind: "transport", code: "timeout" }),
      maxAttempts: 2,
      delayMs: 0,
      onEvidence,
    });

    expect(result.outcome).toBe("failed");
    expect(result.evidence.outcome).toBe("exhausted");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: false,
      },
    ]);
    expect(onEvidence).toHaveBeenCalledWith(result.evidence);
  });

  it("retains failure evidence and bounded diagnostics after a response abort", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-registry-readiness-"));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-length": "8" });
      response.flushHeaders();
      response.write("partial");
      setImmediate(() => response.destroy());
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string", "HTTP server has no TCP port");
      vi.stubEnv("DOCKER_HOST", "unix:///run/user/1000/podman/podman.sock");
      vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
      vi.stubEnv("CONTAINERS_CONF", "/tmp/containers.conf");
      vi.stubEnv("UNRELATED_API_KEY", "must-not-reach-podman");
      const run = vi.fn(
        async (
          _command: TrustedShellCommand,
          _options: ShellProbeRunOptions,
        ): Promise<ShellProbeResult> => ({
          command: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          artifacts: { stdout: "", stderr: "", result: "" },
        }),
      );
      run.mockRejectedValueOnce(new Error("headroom probe unavailable"));
      const result = await collectPortableRegistryReadinessFailure({
        artifacts: new ArtifactSink(root),
        probe: async () => probePortableRegistry(`http://127.0.0.1:${address.port}/v2/`),
        shellProbe: { run } as unknown as ShellProbe,
      });

      expect(result).toEqual({ kind: "transport", code: "unexpected" });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(root, "portable-registry-readiness-retry.json"), "utf8"),
        ),
      ).toMatchObject({
        outcome: "failed-no-retry",
        attempts: [{ attempt: 1, retryScheduled: false }],
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(root, "portable-registry-readiness-failure.json"), "utf8"),
        ),
      ).toEqual({ observation: { kind: "transport", code: "unexpected" } });
      expect(run).toHaveBeenCalledTimes(4);
      expect(run.mock.calls.map(([command]) => command.args[0])).toEqual([
        "-e",
        "container",
        "port",
        "logs",
      ]);
      const [headroomCommand, headroomOptions] = run.mock.calls[0]!;
      expect(headroomCommand.command).toBe("bash");
      expect(headroomCommand.args.slice(0, 5)).toEqual(["-e", "-u", "-o", "pipefail", "-c"]);
      const headroomScript = headroomCommand.args[5]!;
      expect(headroomScript).toContain("/usr/bin/systemctl --user show");
      expect(headroomScript).toContain('/usr/bin/systemctl show "user@');
      expect(headroomScript).not.toMatch(/(^|\n)systemctl /);
      expect(headroomScript).toContain("rlimit_nproc_soft");
      expect(headroomScript).toContain("pids_current=");
      expect(headroomScript).toContain("pids_events_max=");
      expect(headroomScript).toContain("host_pid_max=");
      expect(headroomScript).toContain("host_tasks=");
      expect(headroomOptions.artifactName).toBe("portable-registry-process-headroom");
      const expectedOptions = expect.objectContaining({
        captureLimitBytes: 32 * 1024,
        env: expect.objectContaining({
          CONTAINERS_CONF: "/tmp/containers.conf",
          DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
          XDG_RUNTIME_DIR: "/run/user/1000",
        }),
        timeoutMs: 10_000,
      });
      expect(run).toHaveBeenNthCalledWith(1, expect.anything(), expectedOptions);
      expect(run).toHaveBeenNthCalledWith(2, expect.anything(), expectedOptions);
      expect(run).toHaveBeenNthCalledWith(3, expect.anything(), expectedOptions);
      expect(run).toHaveBeenNthCalledWith(4, expect.anything(), expectedOptions);
      expect(run.mock.calls[0]![1].env).not.toHaveProperty("UNRELATED_API_KEY");
      expect(run.mock.calls[1]![1].env).not.toHaveProperty("UNRELATED_API_KEY");
      expect(run.mock.calls[2]![1].env).not.toHaveProperty("UNRELATED_API_KEY");
      expect(run.mock.calls[3]![1].env).not.toHaveProperty("UNRELATED_API_KEY");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
