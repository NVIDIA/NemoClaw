// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  it("records the registry's finite effective boundary in a sibling Podman scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-registry-boundary-"));
    const evidence = {
      schemaVersion: 2 as const,
      minimumHeadroom: 257,
      service: {
        pid: "3985",
        cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/service",
        tasksMax: 1024,
        tasksCurrent: 21,
        cgroupPidsMax: 1024,
        cgroupPidsCurrent: 21,
      },
      registry: {
        pid: "91453",
        cgroup: "/user.slice/user-1000.slice/user@1000.service/user.slice/podman-42.scope",
      },
      registryCgroups: [
        {
          path: "/user.slice/user-1000.slice/user@1000.service/user.slice/podman-42.scope",
          pidsMax: "max",
          pidsCurrent: 22,
        },
        { path: "/user.slice/user-1000.slice", pidsMax: "157755", pidsCurrent: 50 },
      ],
      effectiveHeadroom: 157705,
      limitingCgroup: "/user.slice/user-1000.slice",
      registryNprocSoft: "239023",
      userTasks: 87,
      hostThreadsMax: 478047,
      hostTasks: 450,
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
      vi.stubEnv("PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM", "257");
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
      expect(command.args[5]).toContain('[[ $registry_group == "$manager_root/"*');
      expect(command.args[5]).toContain('[[ $service_cgroup_max == "$tasks_max" ]]');
      expect(command.args[5]).toContain("(( headroom >= minimum ))");
      expect(command.args[5]).toContain("registry-finite-limit-unavailable");
      expect(command.args[5]).toContain("registry-cgroup-depth-exceeded");
      expect(command.args[5]).toContain("process-identity-changed");
      expect(command.args[5]).toContain("registry-nproc-headroom-insufficient");
      expect(command.args[5]).toContain("host-thread-headroom-insufficient");
      expect(command.args[5]).toContain("fail_boundary service-headroom-insufficient");
      expect(options.env).toHaveProperty("PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM", "257");
      expect(options.env).not.toHaveProperty("UNRELATED_API_KEY");

      // Exercise the actual ancestor walk with fixture cgroups. The root has no
      // pids files, as on cgroup v2; attempting to read it fails this test.
      const script = command.args[5]!;
      const start = script.indexOf("# Podman can move a rootless container");
      const end = script.indexOf("registry_nproc_soft=$(awk", start);
      assert.ok(start >= 0 && end > start);
      const walk = script.slice(start, end);
      const fixtureRoot = path.join(root, "fixture");
      const cgroupRoot = path.join(fixtureRoot, "sys/fs/cgroup");
      const writeHierarchy = (registryGroup: string): void => {
        let group = registryGroup;
        while (group !== "/") {
          const dir = path.join(cgroupRoot, group.slice(1));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "pids.max"), "max\n");
          fs.writeFileSync(path.join(dir, "pids.current"), "20\n");
          group = group.slice(0, group.lastIndexOf("/")) || "/";
        }
      };
      const runWalk = (registryGroup: string) =>
        spawnSync(
          "bash",
          [
            "-c",
            `fixture_root=$1
registry_group=$2
minimum=128
registry_cgroups='[]'
effective_headroom=unavailable
limiting_cgroup=unavailable
cat() { command cat "$fixture_root$1"; }
fail_boundary() { printf 'failure=%s\\n' "$1"; exit 1; }
${walk}
printf 'headroom=%s limiting=%s\\n' "$effective_headroom" "$limiting_cgroup"`,
            "probe",
            fixtureRoot,
            registryGroup,
          ],
          { encoding: "utf8" },
        );

      const registryGroup = evidence.registry.cgroup;
      writeHierarchy(registryGroup);
      expect(fs.existsSync(path.join(cgroupRoot, "pids.max"))).toBe(false);
      const finiteAncestor = path.join(cgroupRoot, "user.slice/user-1000.slice");
      fs.writeFileSync(path.join(finiteAncestor, "pids.max"), "1024\n");
      fs.writeFileSync(path.join(finiteAncestor, "pids.current"), "100\n");
      const passed = runWalk(registryGroup);
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain("headroom=924 limiting=/user.slice/user-1000.slice");

      fs.writeFileSync(path.join(finiteAncestor, "pids.max"), "200\n");
      const exhausted = runWalk(registryGroup);
      expect(exhausted.status).toBe(1);
      expect(exhausted.stdout).toContain("failure=registry-cgroup-headroom-insufficient");

      const deepGroup = `/${Array.from({ length: 25 }, (_, index) => `level-${index}`).join("/")}`;
      writeHierarchy(deepGroup);
      const tooDeep = runWalk(deepGroup);
      expect(tooDeep.status).toBe(1);
      expect(tooDeep.stdout).toContain("failure=registry-cgroup-depth-exceeded");
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
        stdout: JSON.stringify({ failureReason: "registry-cgroup-headroom-insufficient" }),
        stderr: "registry cgroup limit exhausted",
        artifacts: { stdout: "", stderr: "", result: "" },
      }),
    );
    try {
      vi.stubEnv("PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM", "128");
      await expect(
        capturePortableRegistryProcessBoundary({
          artifacts: new ArtifactSink(root),
          shellProbe: { run } as unknown as ShellProbe,
        }),
      ).rejects.toThrow(
        "Portable registry process-boundary verification failed: registry-cgroup-headroom-insufficient.",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, "0", "not-a-number"])(
    "rejects an invalid supplied process headroom threshold: %s",
    async (minimumHeadroom) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-registry-boundary-"));
      try {
        vi.stubEnv("PORTABLE_REGISTRY_MINIMUM_PROCESS_HEADROOM", minimumHeadroom ?? "");
        await expect(
          capturePortableRegistryProcessBoundary({
            artifacts: new ArtifactSink(root),
            shellProbe: { run: vi.fn() } as unknown as ShellProbe,
          }),
        ).rejects.toThrow("Portable registry minimum process headroom must be a positive integer.");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
