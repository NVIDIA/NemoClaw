// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";
import { PEM, LEAF_PEM, PRIVATE_KEY } from "../__test-helpers__/corporate-ca-fixtures";
import { baseGatewayEnv } from "../../../../test/support/openshell-gateway-config-helpers";
import { resolveRegisteredRuntimeProvider } from "../runtime-provider/selection";
import * as runtimeSelection from "../runtime-provider/selection";
import { flowDeps } from "./onboarding";
import { prepareExternalComponentNetwork } from "./network";
import { configureDockerDriverGatewayExternalComponent } from "../docker-driver-gateway-env";
import {
  prepareDockerDriverGatewayConfigEnv,
  readExternalComponentGatewayPreparation,
} from "../docker-driver-gateway-config";
import {
  captureExternalComponentTrust,
  gatewayConfigurationForExternalComponent,
  loadExternalComponentDeclaration,
  parseExternalComponentDeclaration,
  type ExternalComponentDeclarationV2,
} from "./index";
import { prepareExternalComponentGateway, sendExternalComponentActivation } from "./activation";

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function declaration(caCertificatePath = "/run/component/ca.pem"): ExternalComponentDeclarationV2 {
  return {
    schemaVersion: 2,
    componentId: "generic/policy",
    activationSocketPath: "/run/component/activate.sock",
    interceptor: {
      endpoint: "https://127.0.0.1:9443",
      caCertificatePath,
      audience: "urn:generic:admission",
    },
    middleware: {
      name: "generic/middleware",
      endpoint: "https://host.openshell.internal:9444",
      caCertificatePath,
      audience: "urn:generic:middleware",
    },
    providerProfileSource: "generic/policy",
  };
}

function fixture() {
  vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
  const root = fs.mkdtempSync(path.join(path.dirname(process.cwd()), "nc-connections-"));
  roots.push(root);
  const ca = path.join(root, "ca.pem");
  fs.writeFileSync(ca, PEM, { mode: 0o600 });
  const state = path.join(root, "gateway");
  fs.mkdirSync(state, { mode: 0o700 });
  const env = baseGatewayEnv(state);
  env.OPENSHELL_GATEWAY_CONFIG = path.join(state, "openshell-gateway.toml");
  const component = declaration(ca);
  const provider = resolveRegisteredRuntimeProvider("docker")!;
  const gateway = provider.gateway as Extract<typeof provider.gateway, { supported: true }>;
  const observed = gateway.observeHostRuntime({ environment: env, platform: "linux" });
  const inspect = vi.fn(() => ({ gatewayIp: "172.30.115.1", subnet: "172.30.115.0/24" }));
  const network = () => {
    const address = inspect();
    return {
      Id: "a".repeat(64),
      Name: env.OPENSHELL_DOCKER_NETWORK_NAME,
      Driver: "bridge",
      Scope: "local",
      Internal: false,
      IPAM: { Config: [{ Gateway: address.gatewayIp, Subnet: address.subnet }] },
    };
  };
  const run = vi.fn((args: readonly string[], _timeoutMs: number) => ({
    status: 0,
    stdout:
      args[1] === "ls" ? `${env.OPENSHELL_DOCKER_NETWORK_NAME}\n` : JSON.stringify([network()]),
    stderr: "",
  }));
  const runtime = { ...observed, network: { ...observed.network, inspect, run } };
  const settings = gatewayConfigurationForExternalComponent(component);
  const write = () =>
    prepareDockerDriverGatewayConfigEnv(env, state, "/usr/bin/openshell-sandbox", {
      gatewayRuntime: runtime,
      externalComponent: settings,
    });
  const select = () =>
    vi.spyOn(runtimeSelection, "resolveConfiguredRuntimeProvider").mockReturnValue({
      ...provider,
      gateway: { ...gateway, observeHostRuntime: () => runtime },
    });
  return {
    root,
    ca,
    state,
    env,
    component,
    settings,
    runtime,
    provider,
    gateway,
    inspect,
    run,
    network,
    select,
    write,
  };
}

describe("external component connection declaration", () => {
  it("accepts protected connection references for a component-owned manifest (#11507)", () => {
    const parsed = parseExternalComponentDeclaration(JSON.stringify(declaration()));
    expect(parsed).toEqual(declaration());
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["HTTP", "http://127.0.0.1:9443"],
    ["remote hosts", "https://example.com:9443"],
    ["alternate loopback addresses", "https://127.1:9443"],
    ["credentials", "https://user:pass@127.0.0.1:9443"],
    ["paths", "https://127.0.0.1:9443/rpc"],
    ["queries", "https://127.0.0.1:9443?key=value"],
    ["fragments", "https://127.0.0.1:9443#fragment"],
    ["missing ports", "https://127.0.0.1"],
    ["wildcards", "https://0.0.0.0:9443"],
    ["invalid ports", "https://127.0.0.1:65536"],
  ])("rejects interceptor endpoints with %s (#11507)", (_title, endpoint) => {
    const value = declaration();
    expect(() =>
      parseExternalComponentDeclaration(
        JSON.stringify({ ...value, interceptor: { ...value.interceptor, endpoint } }),
      ),
    ).toThrow(/endpoint_restricted/);
  });

  it.each(["https://127.0.0.1:9444", "https://172.30.115.1:9444", "https://example.com:9444"])(
    "requires the managed bridge selector for middleware endpoint %s (#11507)",
    (endpoint) => {
      const value = declaration();
      expect(() =>
        parseExternalComponentDeclaration(
          JSON.stringify({ ...value, middleware: { ...value.middleware, endpoint } }),
        ),
      ).toThrow(/endpoint_restricted/);
    },
  );

  it.each(["bindings", "failurePolicy", "bindingPolicy", "allowInsecureTransport"])(
    "rejects declaration overrides of %s (#11507)",
    (field) => {
      const value = declaration();
      expect(() =>
        parseExternalComponentDeclaration(
          JSON.stringify({ ...value, interceptor: { ...value.interceptor, [field]: [] } }),
        ),
      ).toThrow(/declaration_unknown_field/);
    },
  );

  it("rejects an unregistered provider-profile source (#11507)", () => {
    expect(() =>
      parseExternalComponentDeclaration(
        JSON.stringify({ ...declaration(), providerProfileSource: "unregistered" }),
      ),
    ).toThrow(/declaration_invalid/);
  });
});

describe("external component trust", () => {
  it.each(["", "invalid PEM", LEAF_PEM, PEM + PRIVATE_KEY, PEM + "unrecognized text"])(
    "rejects invalid certificate content %# (#11507)",
    (content) => {
      const f = fixture();
      fs.writeFileSync(f.ca, content);
      expect(() => captureExternalComponentTrust(f.ca)).toThrow(/trust_invalid/);
    },
  );

  it("rejects expired and not-yet-valid trust (#11507)", () => {
    const f = fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2040-01-01"));
    expect(() => captureExternalComponentTrust(f.ca)).toThrow(/trust_invalid/);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2020-01-01"));
    expect(() => captureExternalComponentTrust(f.ca)).toThrow(/trust_invalid/);
  });

  it.each(["symlink", "hardlink", "writable file", "writable parent", "directory", "oversized"])(
    "rejects a trust path with %s (#11507)",
    (kind) => {
      const f = fixture();
      const mutations: Record<string, () => string> = {
        symlink: () => {
          const target = path.join(f.root, "link.pem");
          fs.symlinkSync(f.ca, target);
          return target;
        },
        hardlink: () => {
          fs.linkSync(f.ca, path.join(f.root, "other.pem"));
          return f.ca;
        },
        "writable file": () => {
          fs.chmodSync(f.ca, 0o666);
          return f.ca;
        },
        "writable parent": () => {
          fs.chmodSync(f.root, 0o777);
          return f.ca;
        },
        directory: () => f.root,
        oversized: () => {
          fs.writeFileSync(f.ca, "x".repeat(65537));
          return f.ca;
        },
      };
      const target = mutations[kind]!();
      expect(() => captureExternalComponentTrust(target)).toThrow(/trust_invalid/);
    },
  );

  it("detects replacement and content drift after pinning public trust (#11507)", () => {
    const f = fixture();
    const proof = captureExternalComponentTrust(f.ca);
    proof.revalidate();
    fs.appendFileSync(f.ca, "\n");
    expect(() => proof.revalidate()).toThrow(/trust_changed/);
    fs.writeFileSync(f.ca, PEM);
    fs.renameSync(f.ca, `${f.ca}.old`);
    fs.writeFileSync(f.ca, PEM, { mode: 0o600 });
    expect(() => proof.revalidate()).toThrow(/trust_changed/);
  });
});

describe("managed gateway connection configuration", () => {
  it.each(["missing", "existing"])(
    "uses the inspected %s network before writing connections (#11606)",
    async (state) => {
      const f = fixture();
      f.select();
      const operations: Record<string, () => { status: number; stdout: string; stderr: string }> = {
        ls: () => ({
          status: 0,
          stdout: state === "existing" ? `${f.env.OPENSHELL_DOCKER_NETWORK_NAME}\n` : "",
          stderr: "",
        }),
        create: () => {
          expect(state).toBe("missing");
          expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG!)).toBe(false);
          return { status: 0, stdout: f.network().Id, stderr: "" };
        },
        inspect: () => ({ status: 0, stdout: JSON.stringify([f.network()]), stderr: "" }),
      };
      f.run.mockImplementation((args) => operations[args[1]!]!());
      const deps = flowDeps(
        { collectGatewayReadiness: async () => undefined },
        () => f.env,
        vi.fn(),
      );
      const preparation = await deps.configureExternalComponentGateway(f.settings);
      expect(preparation?.network).toEqual({
        gatewayIp: "172.30.115.1",
        subnet: "172.30.115.0/24",
      });
      expect(f.run.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(
        state === "missing" ? 1 : 0,
      );
      expect(
        f.run.mock.calls.every(([args]) => ["inspect", "ls", "create"].includes(args[1]!)),
      ).toBe(true);
      const config = fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8");
      expect(config).toContain("https://172.30.115.1:9444");
      expect(config).toContain('socket_path = "/var/run/docker.sock"');
      preparation!.revalidate();
      f.run.mockReturnValue({
        status: 0,
        stdout: JSON.stringify([{ ...f.network(), Id: "b".repeat(64) }]),
        stderr: "",
      });
      expect(() => preparation!.revalidate()).toThrow();
    },
  );

  it.each(["creation race", "timeout", "command failure"])(
    "reconciles %s through inspection without repeating creation (#11606)",
    async (failure) => {
      const f = fixture();
      f.select();
      f.run.mockImplementation((args) => ({
        status: args[1] === "create" ? 1 : 0,
        timedOut: args[1] === "create" && failure === "timeout",
        stdout: args[1] === "ls" ? "" : JSON.stringify([f.network()]),
        stderr: "untrusted diagnostics",
      }));
      const guard = await prepareExternalComponentNetwork(f.env, f.runtime);
      guard.revalidate();
      expect(f.run.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
      expect(
        f.run.mock.calls.every(([args]) => ["ls", "create", "inspect"].includes(args[1]!)),
      ).toBe(true);
    },
  );

  it.each(["command failure", "timeout", "invalid output", "wrong identity", "readback failure"])(
    "stops before writing connections after unresolved network %s (#11606)",
    async (failure) => {
      const f = fixture();
      f.select();
      f.run.mockImplementation((args) => ({
        status:
          args[1] === "ls"
            ? 0
            : args[1] === "inspect"
              ? failure === "wrong identity" || failure === "invalid output"
                ? 0
                : 1
              : failure === "command failure"
                ? 1
                : 0,
        timedOut: args[1] === "create" && failure === "timeout",
        stdout:
          args[1] === "ls"
            ? ""
            : args[1] === "inspect"
              ? JSON.stringify([f.network()])
              : failure === "invalid output"
                ? "invalid"
                : "b".repeat(64),
        stderr: "service diagnostics must not be forwarded",
      }));
      const deps = flowDeps(
        { collectGatewayReadiness: async () => undefined },
        () => f.env,
        vi.fn(),
      );
      await expect(deps.configureExternalComponentGateway(f.settings)).rejects.toThrow(
        "preparation_failed",
      );
      expect(f.run.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
      expect(f.run.mock.calls.some(([args]) => args[1] === "rm")).toBe(false);
      expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG!)).toBe(false);
    },
  );

  it.each([
    "listing failure",
    "duplicate names",
    "inspection failure",
    "incompatible bridge",
    "unexpected name",
  ])("stops without creation after %s (#11606)", async (failure) => {
    const f = fixture();
    f.select();
    f.run.mockImplementation((args) => ({
      status:
        failure === "listing failure" || (failure === "inspection failure" && args[1] === "inspect")
          ? 1
          : 0,
      stdout:
        args[1] === "ls"
          ? failure === "unexpected name"
            ? "another-network"
            : `${f.env.OPENSHELL_DOCKER_NETWORK_NAME}\n`.repeat(
                failure === "duplicate names" ? 2 : 1,
              )
          : JSON.stringify([
              { ...f.network(), Driver: failure === "incompatible bridge" ? "overlay" : "bridge" },
            ]),
      stderr: "",
    }));
    const deps = flowDeps({ collectGatewayReadiness: async () => undefined }, () => f.env, vi.fn());
    await expect(deps.configureExternalComponentGateway(f.settings)).rejects.toThrow(
      "preparation_failed",
    );
    expect(f.run.mock.calls.some(([args]) => args[1] === "create")).toBe(false);
    expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG!)).toBe(false);
  });

  it.each([
    null,
    { componentId: "generic-component", interceptorSocketPath: "/run/component/interceptor.sock" },
  ])("keeps ordinary and v1 onboarding free of network preparation: %j", async (component) => {
    const f = fixture();
    f.select();
    const deps = flowDeps({ collectGatewayReadiness: async () => undefined }, () => f.env, vi.fn());
    await deps.configureExternalComponentGateway(component);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("pins the selected Docker context in network commands and gateway configuration (#11606)", async () => {
    const f = fixture();
    f.select();
    vi.stubEnv("DOCKER_HOST", undefined);
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args, timeout) =>
      args[0] === "context"
        ? { status: 0, stdout: "unix:///run/user/1000/docker.sock\n", stderr: "" }
        : original(args, timeout),
    );
    const deps = flowDeps({ collectGatewayReadiness: async () => undefined }, () => f.env, vi.fn());
    const preparation = await deps.configureExternalComponentGateway(f.settings);
    expect(f.run).toHaveBeenCalledWith(
      ["network", "inspect", f.env.OPENSHELL_DOCKER_NETWORK_NAME],
      10_000,
      {
        maxOutputBytes: 16 * 1024,
        environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      },
    );
    expect(fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8")).toContain(
      'socket_path = "/run/user/1000/docker.sock"',
    );
    vi.stubEnv("DOCKER_HOST", "unix:///another/docker.sock");
    expect(() => preparation!.revalidate()).toThrow();
  });

  it("rejects a context switch during configuration before writing connections (#11606)", async () => {
    const f = fixture();
    f.select();
    vi.stubEnv("DOCKER_HOST", undefined);
    const original = f.run.getMockImplementation()!;
    const contexts = [
      "unix:///run/selected/docker.sock",
      "unix:///run/selected/docker.sock",
      "unix:///run/other/docker.sock",
    ];
    f.run.mockImplementation((args, timeout) =>
      args[0] === "context"
        ? {
            status: 0,
            stdout: `${contexts.shift() ?? "unix:///run/selected/docker.sock"}\n`,
            stderr: "",
          }
        : original(args, timeout),
    );
    const deps = flowDeps({ collectGatewayReadiness: async () => undefined }, () => f.env, vi.fn());
    await expect(deps.configureExternalComponentGateway(f.settings)).rejects.toThrow();
    expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG!)).toBe(false);
    expect(f.run.mock.calls.some(([args]) => args[1] === "create" || args[1] === "rm")).toBe(false);
  });

  it.each(["podman", "kubernetes"])(
    "rejects %s before network provisioning (#11606)",
    async (driver) => {
      const f = fixture();
      await expect(
        prepareExternalComponentNetwork(f.env, { ...f.runtime, openShellDriver: driver }),
      ).rejects.toThrow("preparation_failed");
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    "incompatible driver",
    "multiple networks",
    "multiple IPv4 ranges",
    "mismatched subnet",
    "public address",
  ])("rejects %s before writing component configuration", (kind) => {
    const f = fixture();
    const network = f.network();
    const mutations: Record<string, () => void> = {
      "incompatible driver": () => {
        network.Driver = "overlay";
      },
      "multiple IPv4 ranges": () => {
        network.IPAM.Config.push({ Gateway: "172.31.1.1", Subnet: "172.31.1.0/24" });
      },
      "mismatched subnet": () => {
        network.IPAM.Config[0]!.Gateway = "172.29.1.1";
      },
      "public address": () => {
        network.IPAM.Config[0]!.Gateway = "8.8.8.8";
      },
      "multiple networks": () => {},
    };
    mutations[kind]!();
    f.run.mockReturnValue({
      status: 0,
      stdout: JSON.stringify(kind === "multiple networks" ? [network, network] : [network]),
      stderr: "",
    });
    expect(() => f.write()).toThrow("endpoint_restricted");
    expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG!)).toBe(false);
  });

  it("writes authenticated connections and delegates callback selection to the component (#11507)", () => {
    const f = fixture();
    f.write();
    const config = fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8");
    const parsed = parseToml(config) as any;
    const gateway = parsed.openshell.gateway;
    expect(gateway.provider_profile_sources).toEqual([
      { type: "interceptor", name: f.component.componentId },
    ]);
    expect(gateway.interceptors[0]).toMatchObject({
      binding_policy: "dynamic",
      allow_insecure_transport: false,
      audience: f.component.interceptor.audience,
    });
    expect(gateway.interceptors[0]).not.toHaveProperty("bindings");
    expect(gateway.interceptors[0]).not.toHaveProperty("failure_policy");
    expect(parsed.openshell.supervisor.middleware[0]).toMatchObject({
      grpc_endpoint: "https://172.30.115.1:9444",
      allow_insecure_transport: false,
    });
    expect(() => f.write()).not.toThrow();
    expect(fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8")).toBe(config);
    vi.spyOn(runtimeSelection, "resolveConfiguredRuntimeProvider").mockReturnValue({
      ...f.provider,
      gateway: { ...f.gateway, observeHostRuntime: () => f.runtime },
    });
    const preparation = configureDockerDriverGatewayExternalComponent(f.env, f.settings);
    assert.ok(preparation, "configuration must return the component preparation");
    expect(preparation.gateway.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(preparation.gateway.extensionTokenTtlSecs).toBe(900);
    expect(preparation.network).toEqual({ gatewayIp: "172.30.115.1", subnet: "172.30.115.0/24" });
    expect(JSON.stringify(preparation)).not.toContain("PRIVATE");
    preparation.revalidate();
  });

  it.each([
    'binding_policy = "dynamic"',
    "allow_insecure_transport = false",
    "172.30.115.1",
    "ca-sha256",
  ])("refuses to replace changed configuration at %s (#11507)", (setting) => {
    const f = fixture();
    f.write();
    const file = f.env.OPENSHELL_GATEWAY_CONFIG!;
    const changed = fs.readFileSync(file, "utf-8").replace(setting, `${setting}-changed`);
    fs.writeFileSync(file, changed);
    expect(() => f.write()).toThrow();
    expect(fs.readFileSync(file, "utf-8")).toBe(changed);
  });

  it("rejects network and CA drift after configuration and public handoff (#11507)", () => {
    const f = fixture();
    f.write();
    const preparation = readExternalComponentGatewayPreparation(f.env, f.settings, f.runtime);
    f.inspect.mockReturnValue({ gatewayIp: "172.30.116.1", subnet: "172.30.116.0/24" });
    expect(() => preparation.revalidate()).toThrow(/preparation_failed/);
    expect(() => f.write()).toThrow();
    f.inspect.mockReturnValue({ gatewayIp: "172.30.115.1", subnet: "172.30.115.0/24" });
    fs.appendFileSync(f.ca, "\n");
    expect(() => preparation.revalidate()).toThrow(/preparation_failed/);
    expect(() => f.write()).toThrow();
  });

  it("rejects a missing managed bridge before writing component configuration (#11507)", () => {
    const f = fixture();
    f.inspect.mockReturnValue({ gatewayIp: "", subnet: "" });
    expect(() => f.write()).toThrow(/endpoint_restricted/);
    expect(fs.existsSync(f.env.OPENSHELL_GATEWAY_CONFIG ?? "")).toBe(false);
  });

  it("detects removal of the component before launch rewrites configuration (#11507)", () => {
    const f = fixture();
    f.write();
    const expectedEnv = { ...f.env };
    prepareDockerDriverGatewayConfigEnv(f.env, f.state, "/usr/bin/openshell-sandbox", {
      gatewayRuntime: f.runtime,
      externalComponent: null,
    });
    const removed = fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8");
    expect(() =>
      prepareDockerDriverGatewayConfigEnv(expectedEnv, f.state, "/usr/bin/openshell-sandbox", {
        gatewayRuntime: f.runtime,
      }),
    ).toThrow(/external component configuration changed/);
    expect(fs.readFileSync(f.env.OPENSHELL_GATEWAY_CONFIG!, "utf-8")).toBe(removed);
  });
});

async function preparedFixture(response: (request: Record<string, any>) => unknown) {
  const f = fixture();
  f.write();
  const socket = path.join(f.root, "activate.sock");
  const server = http.createServer((request, reply) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      expect(request.url).toBe("/v2/prepare");
      const result = JSON.stringify(response(JSON.parse(body)));
      reply.writeHead(200, { "content-length": Buffer.byteLength(result), connection: "close" });
      reply.end(result);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  servers.push(server);
  fs.chmodSync(socket, 0o600);
  const declarationPath = path.join(f.root, "external-component.json");
  fs.writeFileSync(
    declarationPath,
    JSON.stringify({ ...f.component, activationSocketPath: socket }),
    { mode: 0o600 },
  );
  const component = loadExternalComponentDeclaration({
    declarationPath,
    homeDirectory: f.root,
    platform: "linux",
  })!;
  const preparation = readExternalComponentGatewayPreparation(f.env, f.settings, f.runtime);
  return { ...f, component, preparation, socket };
}

describe("component preparation", () => {
  it("delivers public identity and resolves service preparation on the existing socket (#11507)", async () => {
    const requests: Record<string, any>[] = [];
    const f = await preparedFixture((request) => {
      requests.push(request);
      return {
        schemaVersion: 2,
        preparationId: request.preparationId,
        componentId: request.componentId,
        result: "prepared",
      };
    });
    await prepareExternalComponentGateway(f.component, "generic-gateway", f.preparation);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.gateway).toMatchObject({
      name: "generic-gateway",
      extensionTokenTtlSecs: 900,
    });
    expect(requests[0]?.network.gatewayIp).toBe("172.30.115.1");
    expect(JSON.stringify(requests)).not.toContain("PRIVATE");
    f.component.revalidateBeforeActivation();
    fs.appendFileSync(f.ca, "\n");
    expect(() => f.component.revalidateBeforeActivation()).toThrow(/trust_changed/);
  });

  it.each(["rejected", "wrong identity", "unknown field"])(
    "fails closed when preparation returns %s (#11507)",
    async (kind) => {
      const f = await preparedFixture((request) => ({
        schemaVersion: 2,
        preparationId: kind === "wrong identity" ? "wrong" : request.preparationId,
        componentId: request.componentId,
        result: kind === "rejected" ? "rejected" : "prepared",
        ...(kind === "unknown field" ? { command: "ignored" } : {}),
      }));
      await expect(
        prepareExternalComponentGateway(f.component, "generic-gateway", f.preparation),
      ).rejects.toThrow(/preparation_failed/);
    },
  );

  it("does not retry failed preparation or expose transport diagnostics (#11507)", async () => {
    const f = await preparedFixture(() => ({}));
    const transport = vi
      .fn<typeof sendExternalComponentActivation>()
      .mockRejectedValue(new Error("private transport detail"));
    await expect(
      prepareExternalComponentGateway(f.component, "generic-gateway", f.preparation, transport),
    ).rejects.toThrow(/preparation_failed/);
    expect(transport).toHaveBeenCalledOnce();
  });
});
