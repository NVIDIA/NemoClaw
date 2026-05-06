// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runFixCoreDns, runSetupDnsProxy } from "../../../dist/lib/actions/dns.js";
import type { CommandResult } from "./dns";

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): CommandResult {
  return { status: 1, stdout: "", stderr };
}

describe("runFixCoreDns", () => {
  it("skips cleanly when no supported local Docker socket is detected", () => {
    const log = vi.fn();
    const result = runFixCoreDns({}, { env: { HOME: "/tmp/none" }, existsSocket: () => false, log });

    expect(result).toEqual({ exitCode: 0, runtime: "unknown", skipped: true });
    expect(log).toHaveBeenCalledWith("Skipping CoreDNS patch: no supported Colima or Podman Docker socket found.");
  });

  it("skips unsupported explicit Docker hosts", () => {
    const log = vi.fn();
    const result = runFixCoreDns(
      {},
      {
        env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
        log,
        runDocker: vi.fn(),
      },
    );

    expect(result).toEqual({ exitCode: 0, runtime: "custom", skipped: true });
    expect(log).toHaveBeenCalledWith("Skipping CoreDNS patch: no supported Colima or Podman Docker socket found.");
  });

  it("patches CoreDNS through docker with JSON-escaped Corefile payload", () => {
    const calls: Array<[string, string[]]> = [];
    const log = vi.fn();
    const runDocker = vi.fn((args: string[]) => {
      calls.push(["docker", args]);
      if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
      if (args[0] === "exec" && args[2] === "cat") return ok("nameserver 9.9.9.9\n");
      return ok();
    });

    const result = runFixCoreDns(
      { gatewayName: "nemoclaw" },
      {
        env: { DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" },
        log,
        readFile: () => "nameserver 1.1.1.1\n",
        runDocker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.upstreamDns).toBe("9.9.9.9");
    const patchCall = calls.find(([, args]) => args.includes("patch"));
    expect(patchCall).toBeTruthy();
    const patchJson = patchCall?.[1].at(-1) ?? "";
    expect(JSON.parse(patchJson).data.Corefile).toContain("forward . 9.9.9.9");
    expect(log).toHaveBeenCalledWith("Done. DNS should resolve in ~10 seconds.");
  });

  it("does not probe the Colima VM resolver for non-Colima runtimes", () => {
    const run = vi.fn(() => ok("nameserver 8.8.8.8\n"));
    const result = runFixCoreDns(
      { gatewayName: "nemoclaw" },
      {
        commandExists: () => true,
        env: { DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" },
        log: vi.fn(),
        readFile: () => "nameserver 1.1.1.1\n",
        run,
        runDocker: (args) => {
          if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
          if (args[0] === "exec" && args[2] === "cat") return ok("nameserver 9.9.9.9\n");
          return ok();
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before patching when the upstream contains shell metacharacters", () => {
    const calls: Array<[string, string[]]> = [];
    const result = runFixCoreDns(
      { gatewayName: "nemoclaw" },
      {
        env: { DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" },
        readFile: () => "nameserver 1.1.1.1\n",
        runDocker: (args) => {
          calls.push(["docker", args]);
          if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
          if (args[0] === "exec" && args[2] === "cat") return ok("nameserver bad;rm\n");
          return ok();
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("contains invalid characters");
    expect(calls.some(([, args]) => args.includes("patch"))).toBe(false);
  });

  it("returns non-zero when docker patching fails", () => {
    const result = runFixCoreDns(
      { gatewayName: "nemoclaw" },
      {
        env: { DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" },
        readFile: () => "nameserver 1.1.1.1\n",
        log: vi.fn(),
        runDocker: (args) => {
          if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
          if (args[0] === "exec" && args[2] === "cat") return ok("nameserver 9.9.9.9\n");
          if (args.includes("patch")) return fail("patch failed");
          return ok();
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.message).toBe("patch failed");
  });
});

describe("runSetupDnsProxy", () => {
  it("configures the DNS proxy through kubectl-in-docker argv calls", () => {
    const calls: string[][] = [];
    const log = vi.fn();
    const runDocker = vi.fn((args: string[]) => {
      calls.push(args);
      const cmd = args.join(" ");
      if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
      if (cmd.includes("get endpoints kube-dns")) return ok("10.43.0.10");
      if (cmd.includes("get pods -n openshell -o name")) return ok("pod/box[1]-abc\n");
      if (cmd.includes("ip addr show")) return ok("10.200.0.1\n");
      if (cmd.includes("cat /tmp/dns-proxy.pid")) return ok("12345\n");
      if (cmd.includes("cat /tmp/dns-proxy.log")) return ok("dns-proxy: 10.200.0.1:53 -> 10.43.0.10:53 pid=12345\n");
      if (cmd.includes("python3 -c")) return ok("ok");
      if (cmd.includes("ls /run/netns/")) return ok("sandbox-ns\n");
      if (cmd.includes("test -x")) return ok();
      if (cmd.includes("cat /etc/resolv.conf")) return ok("nameserver 10.200.0.1\n");
      if (cmd.includes("getent hosts github.com")) return ok("140.82.112.4 github.com\n");
      return ok();
    });

    const result = runSetupDnsProxy(
      { gatewayName: "nemoclaw", sandboxName: "box[1]" },
      {
        env: { DOCKER_HOST: "unix:///tmp/fake-docker.sock" },
        log,
        runDocker,
        sleep: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.pod).toBe("box[1]-abc");
    expect(result.verificationPass).toBe(4);
    expect(calls.some((args) => args.includes("box[1]-abc"))).toBe(true);
    expect(calls.some((args) => args.join(" ").includes("nohup python3 -u /tmp/dns-proxy.py '10.43.0.10' '10.200.0.1'"))).toBe(true);
    expect(log).toHaveBeenCalledWith("  DNS verification: 4 passed, 0 failed");
  });

  it("rejects unsafe DNS upstreams before launching the forwarder", () => {
    const calls: string[][] = [];
    const result = runSetupDnsProxy(
      { gatewayName: "nemoclaw", sandboxName: "box" },
      {
        env: { DOCKER_HOST: "unix:///tmp/fake-docker.sock" },
        runDocker: (args) => {
          calls.push(args);
          const cmd = args.join(" ");
          if (args[0] === "ps") return ok("openshell-cluster-nemoclaw\n");
          if (cmd.includes("get endpoints kube-dns")) return ok("bad;rm\n");
          return ok();
        },
        sleep: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("contains invalid characters");
    expect(calls.some((args) => args.join(" ").includes("dns-proxy.py"))).toBe(false);
  });
});
