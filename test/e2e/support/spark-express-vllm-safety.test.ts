// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { TrustedShellCommand } from "../fixtures/shell-probe.ts";
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  cleanupSparkMuseSandbox,
  inspectSandboxIdentity,
  listedSandboxNames,
  sparkMuseGlimmerEnv,
  vllmPublicationProbeUrls,
} from "./spark-express-vllm-safety.ts";

vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: vi.fn(),
}));

const result = (exitCode: number, stdout = "", stderr = "") => ({
  command: ["docker"],
  cwd: "/tmp",
  durationMs: 1,
  exitCode,
  stderr,
  stdout,
});

describe("DGX Spark Express vLLM qualification safety", () => {
  it("clears inherited selections for fresh explicit Muse onboarding (#14065)", () => {
    const overrides = [
      "NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE",
      "NEMOCLAW_LOCAL_MODEL_RUNTIME",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_RECREATE_SANDBOX",
      "NEMOCLAW_SERVING_PRESET",
      "NEMOCLAW_TOOL_DISCLOSURE",
      "NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
      "NEMOCLAW_VLLM_MODEL",
      "NEMOCLAW_SANDBOX_GPU_DEVICE",
    ];
    const inherited = Object.fromEntries(overrides.map((key) => [key, "inherited-choice"]));
    const env = sparkMuseGlimmerEnv({
      ...inherited,
      NEMOCLAW_SANDBOX_NAME: "owned-spark",
      E2E_MANAGED_IMAGE_REVISION: "candidate",
    });
    expect(env).toMatchObject(Object.fromEntries(overrides.map((key) => [key, ""])));
    expect(env).toMatchObject({
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_SANDBOX_GPU: "0",
      NEMOCLAW_VLLM_PORT: "18000",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
      NEMOCLAW_SANDBOX_NAME: "owned-spark",
      E2E_MANAGED_IMAGE_REVISION: "candidate",
    });
  });
  it("probes both allowed addresses and every unintended IPv4 and IPv6 address (#14083)", () => {
    const ipv4 = (address: string, internal = false) => ({
      address,
      internal,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    });
    const ipv6 = (address: string, scopeid = 0) => ({
      address,
      scopeid,
      internal: address === "::1",
      family: "IPv6" as const,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: "",
      cidr: null,
    });
    expect(
      vllmPublicationProbeUrls("172.18.0.1", {
        lo: [ipv4("127.0.0.1", true), ipv6("::1")],
        openshell: [ipv4("172.18.0.1")],
        eth0: [ipv4("192.0.2.10"), ipv6("2001:db8::10"), ipv6("fe80::10", 2)],
      }),
    ).toEqual({
      allowed: ["http://127.0.0.1:8000/health", "http://172.18.0.1:8000/health"],
      denied: [
        "http://[::1]:8000/health",
        "http://192.0.2.10:8000/health",
        "http://[2001:db8::10]:8000/health",
        "http://[fe80::10%25eth0]:8000/health",
      ],
      ipv6: "configured",
    });
  });

  it("reports an IPv4-only host and rejects an empty denial sample", () => {
    const entry = {
      address: "192.0.2.10",
      internal: false,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    };
    expect(vllmPublicationProbeUrls("172.18.0.1", { eth0: [entry] }).ipv6).toBe("unconfigured");
    expect(() => vllmPublicationProbeUrls("172.18.0.1", {})).toThrow("unintended non-loopback");
  });

  it("accepts only local Docker selectors (#8379)", () => {
    expect(() => assertLocalDockerEnvironment({})).not.toThrow();
    expect(() =>
      assertLocalDockerEnvironment({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).not.toThrow();
    expect(() => assertLocalDockerEnvironment({ DOCKER_HOST: "ssh://spark.example" })).toThrow(
      "local Docker socket",
    );
    expect(() => assertLocalDockerEnvironment({ DOCKER_CONTEXT: "remote-spark" })).toThrow(
      "default local Docker context",
    );
  });

  it("distinguishes an absent container from Docker daemon failures (#8379)", () => {
    expect(classifyDockerContainerInspection(result(0, "[]"))).toBe("present");
    expect(
      classifyDockerContainerInspection(result(1, "", "Error: No such object: nemoclaw-vllm")),
    ).toBe("absent");
    expect(() =>
      classifyDockerContainerInspection(
        result(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
      ),
    ).toThrow("Docker container inspection failed");
  });

  it("refuses to treat a failed sandbox listing as an empty host (#8379)", () => {
    expect(listedSandboxNames(result(0, "alpha\nbeta\n"))).toEqual(new Set(["alpha", "beta"]));
    expect(() => listedSandboxNames(result(1, "", "gateway unavailable"))).toThrow(
      "OpenShell sandbox listing failed",
    );
  });

  it("requires an exact sandbox identity and distinguishes absence from inspection failure (#8379)", () => {
    const id = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
    expect(
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "spark-e2e" })), "spark-e2e"),
    ).toEqual({ kind: "present", id });
    expect(inspectSandboxIdentity(result(1, "", "sandbox not found"), "spark-e2e")).toEqual({
      kind: "absent",
    });
    expect(() =>
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "replacement" })), "spark-e2e"),
    ).toThrow("expected identity");
    expect(() => inspectSandboxIdentity(result(1, "", "gateway unavailable"), "spark-e2e")).toThrow(
      "sandbox inspection failed",
    );
    expect(() =>
      inspectSandboxIdentity(result(1, "", "gateway 'nemoclaw' not found"), "spark-e2e"),
    ).toThrow("sandbox inspection failed");
  });
});

describe("Spark Muse cleanup ownership (#14065)", () => {
  const sandboxName = "spark-muse";
  const ownedId = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
  const env = { NEMOCLAW_SANDBOX_NAME: sandboxName };
  it("destroys the recorded sandbox using the same qualification environment", async () => {
    const host = {
      command: vi
        .fn()
        .mockResolvedValue(result(0, JSON.stringify({ name: sandboxName, id: ownedId }))),
      cleanupSandbox: vi.fn().mockResolvedValue(undefined),
    };
    await cleanupSparkMuseSandbox(host, sandboxName, ownedId, env);
    expect(host.cleanupSandbox).toHaveBeenCalledWith(
      sandboxName,
      expect.objectContaining({ env, timeoutMs: 15 * 60_000 }),
    );
  });
  it.each([null, "15d120e4-484c-47d4-9a59-77a08cbb6e67"])(
    "refuses a sandbox without the captured identity [case %#]",
    async (expectedId) => {
      const host = {
        command: vi
          .fn()
          .mockResolvedValue(result(0, JSON.stringify({ name: sandboxName, id: ownedId }))),
        cleanupSandbox: vi.fn(),
      };
      await expect(cleanupSparkMuseSandbox(host, sandboxName, expectedId, env)).rejects.toThrow(
        "unowned or replacement",
      );
      expect(host.cleanupSandbox).not.toHaveBeenCalled();
    },
  );
  it("accepts confirmed absence without destroying another resource", async () => {
    const host = {
      command: vi.fn().mockResolvedValue(result(1, "", "sandbox not found")),
      cleanupSandbox: vi.fn(),
    };
    await cleanupSparkMuseSandbox(host, sandboxName, ownedId, env);
    expect(host.cleanupSandbox).not.toHaveBeenCalled();
  });
  it("stops on inconclusive inventory without destroying a sandbox", async () => {
    const host = {
      command: vi.fn().mockResolvedValue(result(1, "", "gateway unavailable")),
      cleanupSandbox: vi.fn(),
    };
    await expect(cleanupSparkMuseSandbox(host, sandboxName, ownedId, env)).rejects.toThrow(
      "inspection failed",
    );
    expect(host.cleanupSandbox).not.toHaveBeenCalled();
  });
});

describe.each([
  { target: "spark-express-vllm", inheritedCli: undefined, expectedCli: CLI_ENTRYPOINT },
  {
    target: "spark-express-vllm",
    inheritedCli: "/another-checkout/bin/nemoclaw.js",
    expectedCli: CLI_ENTRYPOINT,
  },
  {
    target: "dgx-station-express",
    inheritedCli: "/installed/bin/nemoclaw",
    expectedCli: "/installed/bin/nemoclaw",
  },
])(
  "candidate CLI binding for $target with inherited CLI $inheritedCli (#14065)",
  ({ target, inheritedCli, expectedCli }) => {
    beforeEach(async () => {
      vi.stubEnv("E2E_TARGET_ID", target);
      vi.stubEnv("NEMOCLAW_CLI_BIN", inheritedCli);
      vi.resetModules();
      await import("../live/dgx-express.test.ts");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("uses the selected CLI for first-turn and owned destroy commands", async () => {
      const sandboxName = "spark-muse";
      const ownedId = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
      const run = vi.fn(async (command: TrustedShellCommand) => ({
        command: [command.command, ...command.args],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ name: sandboxName, id: ownedId }),
        stderr: "",
        artifacts: { stdout: "", stderr: "", result: "" },
      }));
      const host = new HostCliClient({ run });
      const turnArgs = [sandboxName, "agent", "-m", "Reply with exactly: MUSE_SELECTOR_OK."];
      await host.nemoclaw(turnArgs);
      await cleanupSparkMuseSandbox(host, sandboxName, ownedId, {});

      expect(run.mock.calls.map(([command]) => [command.command, ...command.args])).toEqual([
        [expectedCli, ...turnArgs],
        ["openshell", "sandbox", "get", "-o", "json", sandboxName],
        [expectedCli, sandboxName, "destroy", "--yes"],
      ]);
    });
  },
);
