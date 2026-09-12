// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { RuntimeProviderGatewayHostRuntime } from "../runtime-provider/contract";
import { prepareExternalComponentNetwork } from "./network";

function fixture() {
  vi.stubEnv("DOCKER_HOST", "unix:///run/user/1000/docker.sock");
  const network = {
    Id: "a".repeat(64),
    Name: "generic.network",
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    IPAM: { Config: [{ Gateway: "172.30.1.1", Subnet: "172.30.1.0/24" }] },
  };
  const run = vi.fn<RuntimeProviderGatewayHostRuntime["network"]["run"]>((args) => ({
    status: 0,
    stdout: args[1] === "ls" ? `${network.Name}\n` : JSON.stringify([network]),
    stderr: "",
  }));
  const runtime = {
    openShellDriver: "docker",
    socketPath: null,
    network: { run },
  } as unknown as RuntimeProviderGatewayHostRuntime;
  const env = { OPENSHELL_DOCKER_NETWORK_NAME: network.Name };
  return { network, run, runtime, env };
}

const failure = { status: 1, stdout: "", stderr: "private diagnostic" };

describe("Docker network provisioning", () => {
  it("matches a dotted network name literally when confirming absence (#11606)", async () => {
    const f = fixture();
    await prepareExternalComponentNetwork(f.env, f.runtime);
    expect(f.run.mock.calls[0]![0]).toEqual([
      "network",
      "ls",
      "--filter",
      "name=^generic\\.network$",
      "--format",
      "{{.Name}}",
    ]);
  });

  it.each(["generic\\network", "generic.*", "generic[network]", "generic$", "generic|network"])(
    "rejects network name %j before calling Docker (#11606)",
    async (name) => {
      const f = fixture();
      f.env.OPENSHELL_DOCKER_NETWORK_NAME = name;
      await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
        "preparation_failed",
      );
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing identity", { Id: "" }],
    ["wrong name", { Name: "another-network" }],
    ["wrong scope", { Scope: "swarm" }],
    ["internal bridge", { Internal: true }],
    ["ingress bridge", { Ingress: true }],
    ["overlay", { Driver: "overlay" }],
    ["network address", { IPAM: { Config: [{ Gateway: "172.30.1.0", Subnet: "172.30.1.0/24" }] } }],
    [
      "broadcast address",
      { IPAM: { Config: [{ Gateway: "172.30.1.255", Subnet: "172.30.1.0/24" }] } },
    ],
    ["public subnet", { IPAM: { Config: [{ Gateway: "8.8.8.1", Subnet: "8.8.8.0/24" }] } }],
    [
      "subnet extending beyond private range",
      { IPAM: { Config: [{ Gateway: "172.16.0.1", Subnet: "172.16.0.0/11" }] } },
    ],
    [
      "noncanonical subnet",
      { IPAM: { Config: [{ Gateway: "172.30.1.2", Subnet: "172.30.1.1/24" }] } },
    ],
    ["no usable hosts", { IPAM: { Config: [{ Gateway: "172.30.1.1", Subnet: "172.30.1.0/31" }] } }],
    ["missing gateway", { IPAM: { Config: [{ Subnet: "172.30.1.0/24" }] } }],
    [
      "multiple IPv4 subnets",
      {
        IPAM: {
          Config: [
            { Gateway: "172.30.1.1", Subnet: "172.30.1.0/24" },
            { Gateway: "172.30.2.1", Subnet: "172.30.2.0/24" },
          ],
        },
      },
    ],
  ])("preserves and rejects a network with %s (#11606)", async (_kind, change) => {
    const f = fixture();
    Object.assign(f.network, change);
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run.mock.calls.every(([args]) => ["ls", "inspect"].includes(args[1]!))).toBe(true);
  });

  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    [
      "identity",
      (f) => {
        f.network.Id = "b".repeat(64);
      },
    ],
    [
      "gateway",
      (f) => {
        f.network.IPAM.Config[0]!.Gateway = "172.30.1.2";
      },
    ],
    [
      "subnet",
      (f) => {
        f.network.IPAM.Config[0]!.Subnet = "172.30.0.0/16";
      },
    ],
    [
      "driver",
      (f) => {
        f.network.Driver = "overlay";
      },
    ],
    [
      "name",
      (f) => {
        f.env.OPENSHELL_DOCKER_NETWORK_NAME = "other";
      },
    ],
    [
      "connection",
      () => {
        vi.stubEnv("DOCKER_HOST", "unix:///another/docker.sock");
      },
    ],
  ])(
    "rejects %s drift before startup without modifying the network (#11606)",
    async (_kind, change) => {
      const f = fixture();
      const guard = await prepareExternalComponentNetwork(f.env, f.runtime);
      change(f);
      expect(guard).toThrow("endpoint_restricted");
      expect(f.run.mock.calls.every(([args]) => ["ls", "inspect"].includes(args[1]!))).toBe(true);
    },
  );

  it.each(["ls", "inspect"])(
    "does not create after a %s output limit failure (#11606)",
    async (operation) => {
      const f = fixture();
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementation((args, ...rest) =>
        args[1] === operation
          ? { ...failure, error: "output limit", errorCode: "ENOBUFS" }
          : original(args, ...rest),
      );
      await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
        "preparation_failed",
      );
      expect(f.run.mock.calls.some(([args]) => args[1] === "create")).toBe(false);
    },
  );

  it("reconciles a creation exception by inspecting the created network (#11606)", async () => {
    const f = fixture();
    f.run
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockImplementationOnce(() => {
        throw new Error("transport failed after request");
      })
      .mockReturnValue({ status: 0, stdout: JSON.stringify([f.network]), stderr: "" });
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).resolves.toBeTypeOf("function");
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(["ls", "create", "inspect"]);
    expect(f.run).toHaveBeenCalledWith(
      ["network", "create", "--driver", "bridge", "--attachable", f.network.Name],
      30_000,
      {
        maxOutputBytes: 16 * 1024,
        environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      },
    );
  });

  it("stops after a creation exception when inspection cannot prove the network (#11606)", async () => {
    const f = fixture();
    f.run
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockImplementationOnce(() => {
        throw new Error("transport failed after request");
      })
      .mockReturnValue(failure);
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(["ls", "create", "inspect"]);
  });

  it.each([
    "tcp://127.0.0.1:2375",
    "ssh://example.test",
    "unix://relative/socket",
    "unix:///tmp/docker.sock\n",
  ])("rejects unsupported Docker connection %j before mutation (#11606)", async (host) => {
    const f = fixture();
    vi.stubEnv("DOCKER_HOST", host);
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run).not.toHaveBeenCalled();
  });

  it("stops when Docker context inspection is ambiguous (#11606)", async () => {
    const f = fixture();
    vi.stubEnv("DOCKER_HOST", undefined);
    f.run.mockReturnValue({ status: 0, stdout: "unix:///a.sock\nunix:///b.sock\n", stderr: "" });
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("reconciles a timed-out creation by inspecting the created network (#11606)", async () => {
    const f = fixture();
    f.run
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ ...failure, timedOut: true, signal: "SIGKILL" })
      .mockReturnValue({ status: 0, stdout: JSON.stringify([f.network]), stderr: "" });
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).resolves.toBeTypeOf("function");
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(["ls", "create", "inspect"]);
  });

  it("stops after a timed-out creation when inspection cannot prove the network (#11606)", async () => {
    const f = fixture();
    f.run
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ ...failure, timedOut: true, signal: "SIGKILL" })
      .mockReturnValue(failure);
    await expect(prepareExternalComponentNetwork(f.env, f.runtime)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual(["ls", "create", "inspect"]);
  });
});
