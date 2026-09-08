// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { applyFixtureProviderPolicyEndpoint } from "../fixtures/gateway-providers.ts";
import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import {
  buildSandboxNodeInvocation,
  buildSandboxShellInvocation,
  FAKE_API_PROXY_READINESS_PORT,
  FAKE_API_PROXY_READINESS_SOURCE,
  FAKE_API_PROXY_SOURCE,
  isNvidiaEndpointRateLimitFailure,
  messagingEnv,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  parseRuntimeProofPort,
  startFakeDockerApi,
} from "../live/messaging-providers-helpers.ts";
import {
  parseInstalledSlackProof,
  SLACK_RUNTIME_DISCOVERY_SOURCE,
} from "../live/messaging-providers-slack-runtime-proof.ts";
import { resolveInstalledTelegramRuntimePath } from "../live/messaging-providers-telegram-runtime-proof.ts";
import { parseInstalledWechatProof } from "../live/messaging-providers-wechat-runtime-proof.ts";

const FAKE_TELEGRAM_API = path.resolve(import.meta.dirname, "../lib/fake-telegram-api.cjs");
const FAKE_SLACK_API = path.resolve(import.meta.dirname, "../lib/fake-slack-api.cjs");
const FAKE_WECHAT_API = path.resolve(import.meta.dirname, "../lib/fake-wechat-api.mts");
const OPENSHELL_BRIDGE_ADDRESS = "172.18.0.1";
const OPENSHELL_NETWORK_INSPECT = JSON.stringify([
  {
    Driver: "bridge",
    IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: OPENSHELL_BRIDGE_ADDRESS }] },
  },
]);
const execFileAsync = promisify(execFile);

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let matched = predicate();
  while (!matched && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    matched = predicate();
  }
  expect(matched, message).toBe(true);
}

type CleanupAction = {
  name: string;
  run: () => Promise<void>;
};

function successfulCommand(stdout = "") {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

function failedCommand(stderr: string) {
  return { ...successfulCommand(), exitCode: 1, stderr };
}

function fakeEndpointPolicy(
  port: number,
  protocol: "rest" | "websocket",
  binaries: readonly string[],
): string {
  return JSON.stringify({
    version: 1,
    network_policies: {
      fixture: {
        endpoints: [{ host: "host.openshell.internal", port, protocol }],
        binaries: binaries.map((binaryPath) => ({ path: binaryPath })),
      },
    },
  });
}

function optionValues(args: string[], option: string): string[] {
  return args.flatMap((argument, index) => (argument === option ? [args[index + 1]!] : []));
}

function optionValue(args: string[], option: string): string {
  return optionValues(args, option)[0]!;
}

function fakePublishedPorts(containerPorts: readonly number[], hostAddress: string) {
  return Object.fromEntries(
    containerPorts.map((containerPort) => {
      return [
        String(containerPort) + "/tcp",
        [{ HostIp: hostAddress, HostPort: fakeHostPort(containerPort) }],
      ];
    }),
  );
}

function fakeHostPort(containerPort: number): string {
  return containerPort === 8081 ? "32101" : containerPort === 8080 ? "32100" : "32079";
}

function publishedPortsFromRun(run: string[], publishedAddress?: string) {
  return Object.fromEntries(
    optionValues(run, "-p").map((publication) => {
      const [commandAddress, containerPort] = publication.split("::");
      return [
        `${containerPort}/tcp`,
        [
          {
            HostIp: publishedAddress ?? commandAddress,
            HostPort: fakeHostPort(Number(containerPort)),
          },
        ],
      ];
    }),
  );
}

type MissingProxyControl =
  | "--cap-drop"
  | "--pids-limit"
  | "--read-only"
  | "--security-opt"
  | "internal-network";

function fakeDockerInspect(
  calls: string[][],
  options: {
    apiPublished: boolean;
    missingProxyControl?: MissingProxyControl;
    proxyEnvironment: readonly string[];
    publishedAddress?: string;
    runtimeProviderId: "docker" | "podman";
  },
): string {
  const [apiRun, proxyRun] = calls.filter((call) => call[0] === "run") as [string[], string[]];
  const apiContainer = optionValue(apiRun, "--name");
  const proxyContainer = optionValue(proxyRun, "--name");
  const apiNetwork = optionValue(apiRun, "--network");
  const connectedProxyNetworks = calls
    .filter((call) => call[0] === "network" && call[1] === "connect" && call[3] === proxyContainer)
    .map((call) => call[2]!);
  const proxyNetworks = [optionValue(proxyRun, "--network"), ...connectedProxyNetworks]
    .filter(
      (network) => options.missingProxyControl !== "internal-network" || network !== apiNetwork,
    )
    .map((network) =>
      options.runtimeProviderId === "podman" && network === "bridge" ? "podman" : network,
    );
  const proxyDropsAllCapabilities = options.missingProxyControl !== "--cap-drop";
  const inspectName = (name: string): string =>
    options.runtimeProviderId === "podman" ? name : `/${name}`;
  return JSON.stringify([
    {
      Name: inspectName(apiContainer),
      HostConfig: {},
      NetworkSettings: {
        Networks: { [apiNetwork]: {} },
        Ports: {
          ...publishedPortsFromRun(apiRun),
          ...(options.apiPublished ? fakePublishedPorts([8080], "0.0.0.0") : {}),
        },
      },
    },
    {
      BoundingCaps:
        options.runtimeProviderId === "podman"
          ? proxyDropsAllCapabilities
            ? null
            : ["CAP_CHOWN"]
          : undefined,
      Config: {
        Env: [...optionValues(proxyRun, "-e"), ...options.proxyEnvironment],
      },
      EffectiveCaps:
        options.runtimeProviderId === "podman"
          ? proxyDropsAllCapabilities
            ? null
            : ["CAP_CHOWN"]
          : undefined,
      Name: inspectName(proxyContainer),
      HostConfig: {
        CapDrop:
          options.runtimeProviderId === "podman"
            ? proxyDropsAllCapabilities
              ? ["CAP_CHOWN"]
              : []
            : proxyDropsAllCapabilities
              ? optionValues(proxyRun, "--cap-drop")
              : [],
        PidsLimit:
          options.missingProxyControl === "--pids-limit"
            ? undefined
            : Number(optionValue(proxyRun, "--pids-limit")),
        ReadonlyRootfs:
          options.missingProxyControl !== "--read-only" && proxyRun.includes("--read-only"),
        SecurityOpt:
          options.missingProxyControl === "--security-opt"
            ? []
            : optionValues(proxyRun, "--security-opt"),
      },
      NetworkSettings: {
        Networks: Object.fromEntries(proxyNetworks.map((network) => [network, {}])),
        Ports: publishedPortsFromRun(proxyRun, options.publishedAddress),
      },
    },
  ]);
}

function fakeDockerHost(
  options: {
    apiPublished?: boolean;
    missingProxyControl?: MissingProxyControl;
    proxyEnvironment?: readonly string[];
    publishedAddress?: string;
    networkInspect?: string;
    proxyRunning?: boolean;
    proxyReady?: boolean;
  } = {},
): {
  artifacts: Map<string, string>;
  calls: string[][];
  commands: Array<{ command: string; args: string[] }>;
  host: HostCliClient;
  resources: () => { containers: string[]; networks: string[] };
  setProxyRunning: (running: boolean) => void;
} {
  const artifacts = new Map<string, string>();
  const calls: string[][] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const containers = new Set<string>();
  const networks = new Set<string>();
  const networkInspect = options.networkInspect ?? OPENSHELL_NETWORK_INSPECT;
  let runtimeProviderId: "docker" | "podman" = "docker";
  let proxyRunning = options.proxyRunning !== false;
  const dockerCommand = (args: string[]) => {
    const executedArgs = [...args];
    calls.push(executedArgs);
    switch (executedArgs[0]) {
      case "network":
        switch (executedArgs[1]) {
          case "inspect": {
            const createdNetwork = calls.find(
              (call) =>
                call[0] === "network" && call[1] === "create" && call.at(-1) === executedArgs[2],
            );
            return successfulCommand(
              executedArgs[2] === "openshell-docker"
                ? networkInspect
                : JSON.stringify([
                    runtimeProviderId === "podman"
                      ? {
                          driver: "bridge",
                          internal: createdNetwork?.includes("--internal") === true,
                        }
                      : {
                          Driver: "bridge",
                          Internal: createdNetwork?.includes("--internal") === true,
                        },
                  ]),
            );
          }
          case "create":
            networks.add(executedArgs.at(-1)!);
            return successfulCommand();
          case "rm":
            networks.delete(executedArgs[2]!);
            return successfulCommand();
          default:
            return successfulCommand();
        }
      case "run":
        containers.add(optionValue(executedArgs, "--name"));
        return successfulCommand();
      case "rm":
        containers.delete(executedArgs.at(-1)!);
        return successfulCommand();
      case "inspect": {
        const container = executedArgs.at(-1)!;
        const component = container.includes("-proxy-") ? "proxy" : "api";
        return !containers.has(container)
          ? failedCommand(`No such container: ${container}`)
          : executedArgs[1] !== "--format"
            ? successfulCommand(
                fakeDockerInspect(calls, {
                  apiPublished: options.apiPublished === true,
                  missingProxyControl: options.missingProxyControl,
                  proxyEnvironment: options.proxyEnvironment ?? [],
                  publishedAddress: options.publishedAddress,
                  runtimeProviderId,
                }),
              )
            : executedArgs[2] === "{{json .State}}"
              ? successfulCommand(
                  `${JSON.stringify({ Running: proxyRunning, source: component })}\n`,
                )
              : successfulCommand(`${String(proxyRunning)}\n`);
      }
      case "logs": {
        const container = executedArgs.at(-1)!;
        return !containers.has(container)
          ? failedCommand(`No such container: ${container}`)
          : successfulCommand(
              `${container.includes("-proxy-") ? "proxy" : "api"} diagnostic logs\n`,
            );
      }
      case "port": {
        const containerPort = Number(executedArgs[2]!.replace(/\/tcp$/u, ""));
        const proxyRun = calls.filter((call) => call[0] === "run").at(-1)!;
        const publication = optionValues(proxyRun, "-p").find((value) =>
          value.endsWith(`::${String(containerPort)}`),
        );
        const commandAddress = publication?.split("::")[0];
        return publication === undefined
          ? failedCommand(`No public port for ${String(containerPort)}/tcp`)
          : successfulCommand(
              `${options.publishedAddress ?? commandAddress}:${fakeHostPort(containerPort)}\n`,
            );
      }
      default:
        return successfulCommand();
    }
  };
  const host = {
    command: async (
      command: string,
      args: string[],
      commandOptions?: { artifactName?: string },
    ) => {
      commands.push({ command, args: [...args] });
      expect(["docker", "node", "podman"]).toContain(command);
      runtimeProviderId =
        command === "podman" ? "podman" : command === "docker" ? "docker" : runtimeProviderId;
      const runtimeArgs = command === "podman" && args[0] === "--url" ? args.slice(2) : args;
      const result =
        command === "node"
          ? options.proxyReady === false
            ? failedCommand("proxy could not reach the upstream API")
            : successfulCommand()
          : dockerCommand(runtimeArgs);
      const artifactNames =
        commandOptions?.artifactName === undefined ? [] : [commandOptions.artifactName];
      for (const artifactName of artifactNames) {
        artifacts.set(artifactName, [result.stdout, result.stderr].filter(Boolean).join("\n"));
      }
      return result;
    },
  } as unknown as HostCliClient;
  return {
    artifacts,
    calls,
    commands,
    host,
    resources: () => ({
      containers: [...containers].sort(),
      networks: [...networks].sort(),
    }),
    setProxyRunning: (running) => {
      proxyRunning = running;
      const autoRemovedContainers = calls
        .filter(
          (args) =>
            !running &&
            args[0] === "run" &&
            args.includes("--rm") &&
            optionValue(args, "--name").includes("-proxy-"),
        )
        .map((args) => optionValue(args, "--name"));
      for (const container of autoRemovedContainers) containers.delete(container);
    },
  };
}

function expectFakeDiscordDiagnosticArtifacts(artifacts: Map<string, string>): void {
  expect(artifacts.get("diagnose-fake-discord-gateway-api-proxy-state")).toContain(
    '"source":"proxy"',
  );
  expect(artifacts.get("diagnose-fake-discord-gateway-api-proxy-logs")).toContain(
    "proxy diagnostic logs",
  );
  expect(artifacts.get("diagnose-fake-discord-gateway-api-state")).toContain('"source":"api"');
  expect(artifacts.get("diagnose-fake-discord-gateway-api-logs")).toContain("api diagnostic logs");
}

function startFakeDiscordApi(
  host: HostCliClient,
  cleanup: CleanupAction[],
  env: NodeJS.ProcessEnv = {},
) {
  return startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
    kind: "discord-gateway",
    imageScript: "fake-discord-gateway.cjs",
    containerPrefix: "fake-discord-gateway",
    portEnv: "FAKE_DISCORD_GATEWAY_PORT",
    captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
    expectedEnv: { FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: "fixture-discord-token" },
    redactionValues: ["fixture-discord-token"],
    env,
  });
}

async function runCleanup(actions: CleanupAction[]): Promise<void> {
  for (let index = actions.length - 1; index >= 0; index -= 1) await actions[index]!.run();
}

async function listenServer(server: net.Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function tcpRequest(host: string, port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("proxy request timed out")));
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

describe("messaging provider installed-runtime proofs", () => {
  it("propagates caller-selected binaries through fake policy application", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const providerName = "e2e-hermes-discord-discord-bridge";
    const allowedBinaries = ["/opt/hermes/.venv/bin/python3", "/opt/hermes/.venv/bin/python"];
    const host = {
      openshellCommandPath: "/usr/local/bin/openshell",
      command: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return args[0] === "sandbox"
          ? successfulCommand(providerName)
          : args[0] === "policy" && args[1] === "get"
            ? successfulCommand(fakeEndpointPolicy(43_117, "websocket", allowedBinaries))
            : successfulCommand();
      },
    } as unknown as HostCliClient;

    await applyFixtureProviderPolicyEndpoint(host, "e2e-hermes-discord", {
      endpoint: { port: "43117" },
      protocol: "websocket",
      rewrite: "websocket-credential-rewrite",
      providerName,
      env: { DISCORD_BOT_TOKEN: "test-fixture-token" },
      redactionValues: ["test-fixture-token"],
      artifactName: "apply-hermes-fake-discord-gateway-policy",
      allowedBinaries,
    });

    expect(commands).toHaveLength(4);
    expect(commands[0]?.args).toEqual([
      "sandbox",
      "provider",
      "list",
      "-g",
      "nemoclaw",
      "e2e-hermes-discord",
    ]);
    expect(commands[1]?.args).toEqual([
      "policy",
      "update",
      "e2e-hermes-discord",
      "--add-endpoint",
      "host.openshell.internal:43117:read-write:websocket:enforce:websocket-credential-rewrite,allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16",
      "--add-allow",
      "host.openshell.internal:43117:GET:/**",
      "--add-allow",
      "host.openshell.internal:43117:WEBSOCKET_TEXT:/**",
      "--binary",
      allowedBinaries[0],
      "--binary",
      allowedBinaries[1],
      "--wait",
    ]);
    expect(commands[2]?.args).toEqual(["policy", "get", "--base", "e2e-hermes-discord"]);
    expect(commands[3]?.args).toEqual([
      "policy",
      "set",
      "--policy",
      expect.any(String),
      "--wait",
      "e2e-hermes-discord",
    ]);
  });

  it("binds the fake Discord REST proof to Hermes Python and excludes Node", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const providerName = "e2e-hermes-discord-discord-bridge";
    const allowedBinaries = ["/opt/hermes/.venv/bin/python"];
    const host = {
      openshellCommandPath: "/usr/local/bin/openshell",
      command: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return args[0] === "sandbox"
          ? successfulCommand(providerName)
          : args[0] === "policy" && args[1] === "get"
            ? successfulCommand(fakeEndpointPolicy(43_118, "rest", allowedBinaries))
            : successfulCommand();
      },
    } as unknown as HostCliClient;

    await applyFixtureProviderPolicyEndpoint(host, "e2e-hermes-discord", {
      endpoint: { port: "43118" },
      protocol: "rest",
      rewrite: "request-body-credential-rewrite",
      providerName,
      env: { DISCORD_BOT_TOKEN: "test-fixture-token" },
      redactionValues: ["test-fixture-token"],
      artifactName: "apply-hermes-fake-discord-rest-policy",
      allowedBinaries,
    });

    expect(commands[0]?.args).toEqual([
      "sandbox",
      "provider",
      "list",
      "-g",
      "nemoclaw",
      "e2e-hermes-discord",
    ]);
    expect(commands[1]?.args).toEqual([
      "policy",
      "update",
      "e2e-hermes-discord",
      "--add-endpoint",
      "host.openshell.internal:43118:read-write:rest:enforce:request-body-credential-rewrite,allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16",
      "--add-allow",
      "host.openshell.internal:43118:GET:/**",
      "--add-allow",
      "host.openshell.internal:43118:POST:/**",
      "--binary",
      allowedBinaries[0],
      "--wait",
    ]);
    expect(commands[1]?.args).not.toContain("/usr/local/bin/node");
    expect(commands[2]?.args).toEqual(["policy", "get", "--base", "e2e-hermes-discord"]);
    expect(commands[3]?.args).toEqual([
      "policy",
      "set",
      "--policy",
      expect.any(String),
      "--wait",
      "e2e-hermes-discord",
    ]);
  });

  it("rejects fake endpoint policy mutation when the provider is not attached", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const host = {
      openshellCommandPath: "/usr/local/bin/openshell",
      command: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return successfulCommand("another-provider");
      },
    } as unknown as HostCliClient;

    await expect(
      applyFixtureProviderPolicyEndpoint(host, "e2e-hermes-discord", {
        endpoint: { port: "43118" },
        protocol: "rest",
        rewrite: "request-body-credential-rewrite",
        providerName: "e2e-hermes-discord-discord-bridge",
        env: { DISCORD_BOT_TOKEN: "test-fixture-token" },
        redactionValues: ["test-fixture-token"],
        artifactName: "apply-hermes-fake-discord-rest-policy",
        allowedBinaries: ["/opt/hermes/.venv/bin/python"],
      }),
    ).rejects.toThrow("is not attached to sandbox e2e-hermes-discord");
    expect(commands.map(({ args }) => args)).toEqual([
      ["sandbox", "provider", "list", "-g", "nemoclaw", "e2e-hermes-discord"],
    ]);
  });

  it("rejects Docker state that publishes the credential-bearing fake API", async () => {
    const { host } = fakeDockerHost({ apiPublished: true });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /Docker topology did not preserve isolation/u,
      );
    } finally {
      await runCleanup(cleanup);
    }
  });

  it.each([
    ["credential value", "PROXY_FIXTURE_VALUE=fixture-discord-token"],
    ["credential name", "FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN=not-a-redaction-value"],
  ])("rejects Docker state that exposes a %s through the fake API proxy", async (_case, leak) => {
    const { host } = fakeDockerHost({ proxyEnvironment: [leak] });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /Docker topology did not preserve isolation/u,
      );
    } finally {
      await runCleanup(cleanup);
    }
  });

  it.each([
    { label: "capability drop", control: "--cap-drop" },
    { label: "PID limit", control: "--pids-limit" },
    { label: "read-only root", control: "--read-only" },
    { label: "security option", control: "--security-opt" },
    { label: "internal-network attachment", control: "internal-network" },
  ] as const)("rejects Docker state missing the proxy $label", async ({ control }) => {
    const { host } = fakeDockerHost({ missingProxyControl: control });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /Docker topology did not preserve isolation/u,
      );
    } finally {
      await runCleanup(cleanup);
    }
  });

  it("returns distinct Slack REST and websocket ports from accepted Docker state", async () => {
    const { host } = fakeDockerHost();
    const cleanup: CleanupAction[] = [];

    try {
      const api = await startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
        kind: "slack",
        imageScript: "fake-slack-api.cjs",
        containerPrefix: "fake-slack",
        portEnv: "FAKE_SLACK_API_PORT",
        captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
        expectedEnv: {},
        redactionValues: [],
        env: {},
      });
      expect(api.port).toBe("32100");
      expect(api.alternatePort).toBe("32101");
    } finally {
      await runCleanup(cleanup);
    }
  });

  it("relays both ports without inheriting host credentials and proves upstream readiness", async () => {
    const upstreamAddress = "127.0.0.1";
    const proxyAddress = "127.0.0.1";
    const inheritedCredentialName = "NEMOCLAW_FAKE_API_PROXY_TEST_CREDENTIAL";
    const previousCredential = process.env[inheritedCredentialName];
    const restoreCredential =
      previousCredential === undefined
        ? () => delete process.env[inheritedCredentialName]
        : () => {
            process.env[inheritedCredentialName] = previousCredential;
          };
    process.env[inheritedCredentialName] = "must-not-reach-the-proxy-child";
    const requests: string[] = [];
    const upstreamServers = ["discord", "slack"].map((label) =>
      net.createServer((socket) => {
        socket.setEncoding("utf8");
        socket.on("data", (payload) => {
          requests.push(`${label}:${payload}`);
          socket.end(`${label}:${payload}`);
        });
      }),
    );
    const upstreamPorts = await Promise.all(
      upstreamServers.map((server) => listenServer(server, upstreamAddress)),
    );
    const portReservations = [net.createServer(), net.createServer(), net.createServer()];
    const [readinessPort, ...proxyPorts] = await Promise.all(
      portReservations.map((server) => listenServer(server, proxyAddress)),
    );
    await Promise.all(portReservations.map(closeServer));
    const credentialGuardSource = `Object.hasOwn(process.env, ${JSON.stringify(inheritedCredentialName)}) && (() => { throw new Error("proxy child inherited host credential"); })();\n`;
    const proxy = spawn(process.execPath, ["-e", credentialGuardSource + FAKE_API_PROXY_SOURCE], {
      env: {
        NEMOCLAW_FAKE_API_UPSTREAM: upstreamAddress,
        NEMOCLAW_FAKE_API_PROXY_LISTEN_ADDRESS: proxyAddress,
        NEMOCLAW_FAKE_API_PROXY_PORTS: proxyPorts
          .map((port, index) => `${String(port)}:${String(upstreamPorts[index])}`)
          .join(","),
        NEMOCLAW_FAKE_API_PROXY_READINESS_PORT: String(readinessPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let proxyStderr = "";
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", (chunk) => {
      proxyStderr += chunk;
    });

    try {
      try {
        await execFileAsync(
          process.execPath,
          ["-e", FAKE_API_PROXY_READINESS_SOURCE, proxyAddress, String(readinessPort)],
          { timeout: 10_000 },
        );
      } catch (error) {
        throw new Error(
          `proxy readiness probe failed: ${error instanceof Error ? error.message : String(error)}; proxy stderr: ${proxyStderr}`,
        );
      }
      const responses = await Promise.all([
        tcpRequest(proxyAddress, proxyPorts[0]!, "gateway"),
        tcpRequest(proxyAddress, proxyPorts[1]!, "websocket"),
      ]);
      expect(responses, proxyStderr).toEqual(["discord:gateway", "slack:websocket"]);
      expect(requests.sort()).toEqual(["discord:gateway", "slack:websocket"]);
    } finally {
      restoreCredential();
      proxy.kill("SIGTERM");
      await (proxy.exitCode === null
        ? once(proxy, "exit").then(() => undefined)
        : Promise.resolve());
      await Promise.all(upstreamServers.map(closeServer));
    }
  });

  it("rejects a fake API proxy port that Docker publishes beyond the OpenShell bridge", async () => {
    const { host } = fakeDockerHost({ publishedAddress: "0.0.0.0" });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /Docker topology did not preserve isolation/u,
      );
    } finally {
      await runCleanup(cleanup);
    }
  });

  it("publishes the isolated proxy through rootless Podman without binding its bridge gateway", async () => {
    const { calls, host } = fakeDockerHost({ networkInspect: "[]" });
    const cleanup: CleanupAction[] = [];

    try {
      const api = await startFakeDiscordApi(host, cleanup, {
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      });
      const proxyRun = calls.filter((args) => args[0] === "run").at(-1)!;
      const publications = optionValues(proxyRun, "-p");

      expect(publications).toContain("0.0.0.0::8080");
      expect(publications).toContain(`0.0.0.0::${String(FAKE_API_PROXY_READINESS_PORT)}`);
      expect(publications.some((entry) => entry.startsWith(`${OPENSHELL_BRIDGE_ADDRESS}::`))).toBe(
        false,
      );
      expect(calls).not.toContainEqual(["network", "inspect", "openshell-docker"]);
      expect(api.port).toBe("32100");
    } finally {
      await runCleanup(cleanup);
    }
  });

  it("rejects effective proxy capabilities reported by rootless Podman", async () => {
    const { host } = fakeDockerHost({
      missingProxyControl: "--cap-drop",
      networkInspect: "[]",
    });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(
        startFakeDiscordApi(host, cleanup, {
          NEMOCLAW_GATEWAY_RUNTIME: "podman",
          OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
        }),
      ).rejects.toThrow(/Podman topology did not preserve isolation/u);
    } finally {
      await runCleanup(cleanup);
    }
  });

  it("rejects ambiguous OpenShell IPv4 gateways and cleans its temporary directory", async () => {
    const networkInspect = JSON.stringify([
      {
        Driver: "bridge",
        IPAM: {
          Config: [
            { Subnet: "172.18.0.0/16", Gateway: OPENSHELL_BRIDGE_ADDRESS },
            { Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" },
          ],
        },
      },
    ]);
    const { calls, host } = fakeDockerHost({ networkInspect });
    const cleanup: CleanupAction[] = [];
    let fixtureDir: string | undefined;

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /exactly one IPv4 bridge gateway/u,
      );
      expect(calls).toEqual([["network", "inspect", "openshell-docker"]]);
      expect(cleanup).toHaveLength(1);
      fixtureDir = cleanup[0]!.name.replace(/^remove /u, "");
      expect(fs.existsSync(fixtureDir)).toBe(true);
    } finally {
      await runCleanup(cleanup);
    }
    expect(fixtureDir).toBeDefined();
    expect(fs.existsSync(fixtureDir!)).toBe(false);
  });

  it("fails with proxy diagnostics when the detached proxy stops before readiness", async () => {
    const { artifacts, host, resources } = fakeDockerHost({ proxyRunning: false });
    const cleanup: CleanupAction[] = [];
    let failure: unknown;

    try {
      await startFakeDiscordApi(host, cleanup);
    } catch (error) {
      failure = error;
    } finally {
      await runCleanup(cleanup);
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "attempted to capture redacted proxy and API diagnostics",
    );
    expectFakeDiscordDiagnosticArtifacts(artifacts);
    expect(resources()).toEqual({ containers: [], networks: [] });
  });

  it("fails with API and proxy diagnostics when the proxy cannot reach the API", async () => {
    const { artifacts, host, resources } = fakeDockerHost({ proxyReady: false });
    const cleanup: CleanupAction[] = [];
    let failure: unknown;

    try {
      await startFakeDiscordApi(host, cleanup);
    } catch (error) {
      failure = error;
    } finally {
      await runCleanup(cleanup);
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "attempted to capture redacted proxy and API diagnostics",
    );
    expectFakeDiscordDiagnosticArtifacts(artifacts);
    expect(resources()).toEqual({ containers: [], networks: [] });
  });

  it("captures proxy diagnostics before cleanup after a post-readiness stop", async () => {
    const { artifacts, host, resources, setProxyRunning } = fakeDockerHost();
    const cleanup: CleanupAction[] = [];

    try {
      await startFakeDiscordApi(host, cleanup);
      setProxyRunning(false);
    } finally {
      await runCleanup(cleanup);
    }

    expectFakeDiscordDiagnosticArtifacts(artifacts);
    expect(resources()).toEqual({ containers: [], networks: [] });
  });

  it("uses a synthetic WeChat token even when the host exports one", () => {
    const previousToken = process.env.WECHAT_BOT_TOKEN;
    process.env.WECHAT_BOT_TOKEN = "host-wechat-token-must-not-reach-the-fake-api";

    try {
      const fixture = messagingEnv();
      expect(fixture.tokens.wechat).toBe("test-fake-wechat-token-e2e");
      expect(fixture.env.WECHAT_BOT_TOKEN).toBe("test-fake-wechat-token-e2e");
    } finally {
      Reflect.deleteProperty(process.env, "WECHAT_BOT_TOKEN");
      Object.assign(
        process.env,
        previousToken === undefined ? {} : { WECHAT_BOT_TOKEN: previousToken },
      );
    }
  });

  it("publishes independent fake Slack REST and websocket ports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-slack-ports-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const child = spawn(process.execPath, [FAKE_SLACK_API], {
      env: {
        ...process.env,
        FAKE_SLACK_API_HOST: "127.0.0.1",
        FAKE_SLACK_API_PORT: "0",
        FAKE_SLACK_API_WEBSOCKET_PORT: "0",
        FAKE_SLACK_API_PORT_FILE: portFile,
        FAKE_SLACK_API_CAPTURE_FILE: captureFile,
        FAKE_SLACK_API_EXPECTED_BOT_TOKEN: "xoxb-fake-slack-port-test",
        FAKE_SLACK_API_EXPECTED_APP_TOKEN: "xapp-fake-slack-port-test",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => fs.existsSync(portFile), `fake Slack listeners did not start: ${stderr}`);
      const listening = fs
        .readFileSync(captureFile, "utf8")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "listening");
      expect(listening).toHaveLength(2);
      expect(listening.map((entry) => entry.kind).sort()).toEqual(["rest", "websocket"]);
      expect(new Set(listening.map((entry) => entry.port)).size).toBe(2);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps raw process-probe tokens out of argv and fails closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-process-token-probe-"));
    const token = `xoxb-nemoclaw-process-probe-secret-${process.pid}`;

    try {
      const selfProc = path.join(dir, "101");
      fs.mkdirSync(selfProc);
      const script = buildProcessTokenProbe(token, dir);
      const invocation = buildSandboxShellInvocation(script);
      fs.writeFileSync(path.join(selfProc, "cmdline"), `${invocation.join("\0")}\0`);

      expect(script).not.toContain(token);
      expect(script).not.toContain("grep");
      expect(script).toContain('case "$nemoclaw_process_probe_cmdline" in');
      expect(invocation.every((argument) => !argument.includes(token))).toBe(true);

      const [command, ...args] = invocation;
      const selfOnlyResults = Array.from({ length: 20 }, () =>
        spawnSync(command, args, { encoding: "utf8" }),
      );
      expect(selfOnlyResults.map((result) => result.status)).toEqual(Array(20).fill(0));
      expect(selfOnlyResults.map((result) => result.stdout.trim())).toEqual(
        Array(20).fill("ABSENT"),
      );

      const otherProc = path.join(dir, "202");
      fs.mkdirSync(otherProc);
      fs.writeFileSync(
        path.join(otherProc, "cmdline"),
        `node\0worker.js\0--messaging-token=${token}\0`,
      );
      const tokenInOtherProcess = spawnSync(command, args, { encoding: "utf8" });
      expect(tokenInOtherProcess.status, tokenInOtherProcess.stderr).toBe(0);
      expect(tokenInOtherProcess.stdout.trim()).toBe("FOUND pid=202");

      fs.rmSync(selfProc, { recursive: true });
      fs.rmSync(otherProc, { recursive: true });
      const noProcessData = spawnSync(command, args, { encoding: "utf8" });
      expect(noProcessData.status, noProcessData.stderr).toBe(0);
      expect(noProcessData.stdout.trim()).toBe("ABSENT");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("reconstructs multi-argument Node source byte-for-byte below the OpenShell limit", () => {
    const source = [
      'import fs from "node:fs";',
      "const scriptUrl = new URL(import.meta.url);",
      'if (process.env.RUNTIME_PROOF_MARKER !== "marker value") throw new Error("missing marker");',
      'const reconstructed = fs.readFileSync(scriptUrl, "utf8");',
      "fs.unlinkSync(scriptUrl);",
      "process.stdout.write(reconstructed);",
      `/* ${"x".repeat(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES * 2)} */`,
    ].join("\n");
    const invocation = buildSandboxNodeInvocation(source, {
      artifactName: `runtime-proof-round-trip-${process.pid}`,
      env: { RUNTIME_PROOF_MARKER: "marker value" },
    });

    expect(invocation.length).toBeGreaterThan(8);
    expect(
      Math.max(...invocation.map((argument) => Buffer.byteLength(argument, "utf8"))),
    ).toBeLessThan(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES);
    expect(invocation.filter((argument) => /[\r\n]/u.test(argument))).toEqual([]);
    const [command, ...args] = invocation;
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(source);
  });

  it("can resolve installed package symlinks for runtime proofs", () => {
    const invocation = buildSandboxNodeInvocation("process.stdout.write('ok')", {
      artifactName: "runtime-proof-realpaths",
      preserveSymlinks: false,
    });
    const shellScript = Buffer.from(invocation.slice(4).join(""), "base64").toString("utf8");

    expect(shellScript).not.toContain("--preserve-symlinks");
    expect(shellScript).toContain("node '/tmp/nemoclaw-runtime-proof-realpaths.mjs'");
    const [command, ...args] = invocation;
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.each([
    ["1", 1],
    ["443", 443],
    ["65535", 65_535],
    ["00080", 80],
  ])("accepts bounded decimal runtime-proof port %s", (rawPort, expected) => {
    expect(parseRuntimeProofPort(rawPort)).toBe(expected);
  });

  it.each(["", "0", "65536", "-1", "+1", "1.5", "1e3", " 443", "443 ", "abc"])(
    "rejects invalid runtime-proof port %j",
    (rawPort) => {
      expect(() => parseRuntimeProofPort(rawPort)).toThrow(/runtime proof port/u);
    },
  );

  it("classifies only rate-limited NVIDIA endpoint validation failures", () => {
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed.\nChat Completions API validation returned HTTP 429",
      ),
    ).toBe(true);
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed: too many requests",
      ),
    ).toBe(true);
    expect(
      isNvidiaEndpointRateLimitFailure(
        [
          "Using Other OpenAI-compatible endpoint with model: nvidia/nvidia/nemotron-3-ultra",
          "No GITHUB_TOKEN (60 req/hr rate limit — set it for better rates)",
          "Docker GPU patch failed: spawnSync docker ETIMEDOUT",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(
      isNvidiaEndpointRateLimitFailure(
        "NVIDIA Endpoints endpoint validation failed: invalid credential",
      ),
    ).toBe(false);
  });

  it("finds Slack only in its canonical managed npm project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-managed-project-"));
    const projectsDir = path.join(dir, "npm", "projects");
    const slackProject = path.join(projectsDir, "openclaw-slack-reviewed");
    const unrelatedProject = path.join(projectsDir, "unrelated-plugin");
    const malformedProject = path.join(projectsDir, "malformed-plugin");
    const slackPackageRoot = path.join(slackProject, "node_modules", "@openclaw", "slack");

    try {
      fs.mkdirSync(slackPackageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(slackProject, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/slack": "2026.7.1" } }),
      );
      fs.mkdirSync(path.join(unrelatedProject, "node_modules", "@openclaw", "slack"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(unrelatedProject, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/discord": "2026.6.10" } }),
      );
      fs.mkdirSync(malformedProject, { recursive: true });
      fs.writeFileSync(path.join(malformedProject, "package.json"), "not json");

      const source = [
        'import fs from "node:fs";',
        'import path from "node:path";',
        SLACK_RUNTIME_DISCOVERY_SOURCE,
        "const candidates = [];",
        "addManagedNpmProjectSlackCandidates(",
        "  process.env.NEMOCLAW_TEST_PROJECTS_DIR,",
        "  (candidate) => candidates.push(path.resolve(candidate)),",
        ");",
        "process.stdout.write(JSON.stringify(candidates));",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_TEST_PROJECTS_DIR: projectsDir },
        input: source,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([path.resolve(slackPackageRoot)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads Slack through its real managed-project root and nested OpenClaw symlink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-runtime-root-"));
    const installRoot = path.join(dir, "lib", "nemoclaw", "openclaw-runtime", "node_modules");
    const openclawPackageRoot = path.join(installRoot, "openclaw");
    const slackProjectRoot = path.join(dir, "state", "npm", "projects", "openclaw-slack");
    const slackPackageRoot = path.join(slackProjectRoot, "node_modules", "@openclaw", "slack");
    const globalNodeModules = path.join(dir, "lib", "node_modules");
    try {
      fs.mkdirSync(path.join(openclawPackageRoot, "dist", "plugin-sdk"), { recursive: true });
      fs.writeFileSync(
        path.join(openclawPackageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.7.1" }),
      );
      fs.writeFileSync(path.join(openclawPackageRoot, "dist", "plugin-sdk", "temp-path.js"), "");
      fs.mkdirSync(path.join(openclawPackageRoot, "node_modules", "ajv"), { recursive: true });
      fs.writeFileSync(
        path.join(openclawPackageRoot, "node_modules", "ajv", "package.json"),
        JSON.stringify({ name: "ajv", version: "8.20.0" }),
      );
      fs.mkdirSync(path.join(installRoot, "fast-uri"), { recursive: true });
      fs.writeFileSync(
        path.join(installRoot, "fast-uri", "package.json"),
        JSON.stringify({ name: "fast-uri", version: "3.1.0" }),
      );
      fs.mkdirSync(globalNodeModules, { recursive: true });
      fs.symlinkSync(openclawPackageRoot, path.join(globalNodeModules, "openclaw"), "dir");
      fs.writeFileSync(
        path.join(openclawPackageRoot, "node_modules", "ajv", "index.js"),
        'import uri from "fast-uri"; export default uri;',
      );
      fs.mkdirSync(path.join(slackPackageRoot, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(slackProjectRoot, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/slack": "2026.7.1" } }),
      );
      fs.writeFileSync(
        path.join(slackPackageRoot, "package.json"),
        JSON.stringify({ name: "@openclaw/slack", type: "module" }),
      );
      fs.writeFileSync(
        path.join(slackPackageRoot, "dist", "runtime-api.js"),
        'export function sendMessageSlack() { return "sent"; }',
      );
      fs.writeFileSync(
        path.join(slackPackageRoot, "dist", "pipeline.runtime-abc.js"),
        'import uri from "../node_modules/openclaw/node_modules/ajv/index.js"; export function prepareSlackMessage() { return uri; }',
      );
      fs.mkdirSync(path.join(slackPackageRoot, "node_modules"), { recursive: true });
      fs.symlinkSync(
        openclawPackageRoot,
        path.join(slackPackageRoot, "node_modules", "openclaw"),
        "dir",
      );
      fs.writeFileSync(path.join(installRoot, "fast-uri", "index.js"), 'export default "loaded";');
      fs.writeFileSync(
        path.join(installRoot, "fast-uri", "package.json"),
        JSON.stringify({ name: "fast-uri", type: "module", exports: "./index.js" }),
      );
      fs.mkdirSync(path.join(globalNodeModules, "@openclaw"), { recursive: true });
      fs.symlinkSync(slackPackageRoot, path.join(globalNodeModules, "@openclaw", "slack"), "dir");

      const source = [
        'import { execFileSync } from "node:child_process";',
        'import fs from "node:fs";',
        'import { createRequire } from "node:module";',
        'import path from "node:path";',
        'import { pathToFileURL } from "node:url";',
        SLACK_RUNTIME_DISCOVERY_SOURCE,
        "const location = resolveOpenClawSlackApiLocation();",
        'const slackDir = path.join(location.root, "dist");',
        "const api = await importProofModules(slackDir);",
        "process.stdout.write(JSON.stringify({",
        "  kind: location.kind,",
        "  root: location.root,",
        "  prepared: api.prepareSlackMessage(),",
        "  sent: api.sendMessageSlack(),",
        "}));",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_PACKAGE_ROOT: path.join(globalNodeModules, "openclaw"),
          OPENCLAW_SLACK_PACKAGE_ROOT: path.join(globalNodeModules, "@openclaw", "slack"),
          OPENCLAW_STATE_DIR: path.join(dir, "state"),
        },
        input: source,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        kind: "external",
        root: fs.realpathSync(slackPackageRoot),
        prepared: "loaded",
        sent: "sent",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads Telegram through the real OpenClaw root with hoisted dependencies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-runtime-root-"));
    const installRoot = path.join(dir, "lib", "nemoclaw", "openclaw-runtime", "node_modules");
    const openclawRoot = path.join(installRoot, "openclaw");
    const globalNodeModules = path.join(dir, "lib", "node_modules");
    const runtimeApi = path.join(openclawRoot, "dist", "extensions", "telegram", "runtime-api.js");

    try {
      fs.mkdirSync(path.dirname(runtimeApi), { recursive: true });
      fs.writeFileSync(
        path.join(openclawRoot, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module" }),
      );
      fs.writeFileSync(
        runtimeApi,
        'import uri from "../../../node_modules/ajv/index.js"; export const proof = uri;',
      );
      fs.mkdirSync(path.join(openclawRoot, "node_modules", "ajv"), { recursive: true });
      fs.writeFileSync(
        path.join(openclawRoot, "node_modules", "ajv", "package.json"),
        JSON.stringify({ name: "ajv", type: "module" }),
      );
      fs.writeFileSync(
        path.join(openclawRoot, "node_modules", "ajv", "index.js"),
        'import uri from "fast-uri"; export default uri;',
      );
      fs.mkdirSync(path.join(installRoot, "fast-uri"), { recursive: true });
      fs.writeFileSync(
        path.join(installRoot, "fast-uri", "package.json"),
        JSON.stringify({ name: "fast-uri", type: "module", exports: "./index.js" }),
      );
      fs.writeFileSync(path.join(installRoot, "fast-uri", "index.js"), 'export default "loaded";');
      fs.mkdirSync(globalNodeModules, { recursive: true });
      fs.symlinkSync(openclawRoot, path.join(globalNodeModules, "openclaw"), "dir");

      const linkedRuntimeApi = path.join(
        globalNodeModules,
        "openclaw",
        "dist",
        "extensions",
        "telegram",
        "runtime-api.js",
      );
      const runtimePath = resolveInstalledTelegramRuntimePath(linkedRuntimeApi, fs.realpathSync);
      const source = [
        'import { pathToFileURL } from "node:url";',
        "const runtimePath = process.env.NEMOCLAW_TEST_TELEGRAM_RUNTIME_PATH;",
        "const runtime = await import(pathToFileURL(runtimePath).href);",
        "process.stdout.write(JSON.stringify({ runtimePath, proof: runtime.proof }));",
      ].join("\n");
      const result = spawnSync(
        process.execPath,
        ["--preserve-symlinks", "--input-type=module", "-"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_TEST_TELEGRAM_RUNTIME_PATH: runtimePath,
          },
          input: source,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        runtimePath,
        proof: "loaded",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports loader stderr without accepting stderr as a Slack proof (#6467)", () => {
    const proof = JSON.stringify({
      ok: true,
      proof: "openclaw-pipeline-runtime",
      allowedReplyTarget: "channel:C0E2ESLACK",
      deniedPrepared: true,
      deniedFeedbackMethod: "chat.postEphemeral",
      deniedFeedbackCount: 1,
      messageId: "1710000000.000201",
      channelId: "C0E2ESLACK",
    });
    const stderr = [
      "[channels] [slack] provider failed to start: this[#customizations].loadSync is not a function",
      proof,
    ].join("\n");

    expect(() => parseInstalledSlackProof("", stderr)).toThrow(
      /stderr:.*loadSync is not a function/su,
    );
  });

  it("continues to accept only a complete Slack proof from stdout (#6467)", () => {
    const proof = {
      ok: true as const,
      proof: "openclaw-pipeline-runtime" as const,
      allowedReplyTarget: "channel:C0E2ESLACK",
      deniedPrepared: true as const,
      deniedFeedbackMethod: "chat.postEphemeral" as const,
      deniedFeedbackCount: 1 as const,
      messageId: "1710000000.000201",
      channelId: "C0E2ESLACK",
    };

    expect(parseInstalledSlackProof(`diagnostic\n${JSON.stringify(proof)}`, "warning")).toEqual(
      proof,
    );
  });

  it("accepts only a complete installed WeChat runtime proof", () => {
    const proof = {
      ok: true as const,
      proof: "openclaw-weixin-runtime-send" as const,
      accountId: "e2e-fake-account-12345",
      messageId: "openclaw-weixin:123-abc",
      pluginVersion: "2.4.3",
    };
    expect(parseInstalledWechatProof(`diagnostic\n${JSON.stringify(proof)}`)).toEqual(proof);
    expect(() => parseInstalledWechatProof(JSON.stringify({ ...proof, accountId: "" }))).toThrow(
      /did not emit a valid result/u,
    );
  });

  it("redacts Telegram tokens from fake API captures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-telegram-redaction-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const token = "123456:SUPER-SECRET-TELEGRAM-TOKEN";
    const child = spawn(process.execPath, [FAKE_TELEGRAM_API], {
      env: {
        ...process.env,
        FAKE_TELEGRAM_API_HOST: "127.0.0.1",
        FAKE_TELEGRAM_API_PORT: "0",
        FAKE_TELEGRAM_API_PORT_FILE: portFile,
        FAKE_TELEGRAM_API_CAPTURE_FILE: captureFile,
        FAKE_TELEGRAM_API_EXPECTED_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => fs.existsSync(portFile), `fake Telegram API did not start: ${stderr}`);
      const port = parseRuntimeProofPort(fs.readFileSync(portFile, "utf8").trim());
      const endpoint = new URL(
        "http://127.0.0.1/bot123456:SUPER-SECRET-TELEGRAM-TOKEN/sendMessage",
      );
      endpoint.port = String(port);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "42424242", text: "redaction proof" }),
      });
      expect(response.status).toBe(200);
      await waitFor(
        () =>
          fs.existsSync(captureFile) &&
          fs.readFileSync(captureFile, "utf8").includes("sendMessage"),
        `fake Telegram API did not capture the request: ${stderr}`,
      );
      const capture = fs.readFileSync(captureFile, "utf8");
      expect(capture).not.toContain(token);
      const request = capture
        .trim()
        .split(/\n+/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "request");
      expect(request).toMatchObject({
        endpoint: "sendMessage",
        path: "/bot[redacted]/sendMessage",
        tokenMatchesExpected: true,
        tokenRedacted: true,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("redacts WeChat tokens from fake iLink API captures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-wechat-redaction-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const token = "test-secret-wechat-ilink-token";
    const child = spawn(process.execPath, ["--experimental-strip-types", FAKE_WECHAT_API], {
      env: {
        ...process.env,
        FAKE_WECHAT_API_HOST: "127.0.0.1",
        FAKE_WECHAT_API_PORT: "0",
        FAKE_WECHAT_API_PORT_FILE: portFile,
        FAKE_WECHAT_API_CAPTURE_FILE: captureFile,
        FAKE_WECHAT_API_EXPECTED_TOKEN: token,
        FAKE_WECHAT_API_EXPECTED_TARGET: "e2e-user@im.wechat",
        FAKE_WECHAT_API_EXPECTED_TEXT: "redaction proof",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => fs.existsSync(portFile), `fake WeChat API did not start: ${stderr}`);
      const port = parseRuntimeProofPort(fs.readFileSync(portFile, "utf8").trim());
      const response = await fetch(`http://127.0.0.1:${port}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          authorizationtype: "ilink_bot_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          msg: {
            to_user_id: "e2e-user@im.wechat",
            context_token: "test-context",
            item_list: [{ text_item: { text: "redaction proof" } }],
          },
          base_info: { channel_version: "2.4.3", bot_agent: "OpenClaw" },
        }),
      });
      expect(response.status).toBe(200);
      await waitFor(
        () => fs.readFileSync(captureFile, "utf8").includes("/ilink/bot/sendmessage"),
        `fake WeChat API did not capture the request: ${stderr}`,
      );
      const capture = fs.readFileSync(captureFile, "utf8");
      expect(capture).not.toContain(token);
      const request = capture
        .trim()
        .split(/\n+/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "request");
      expect(request).toMatchObject({
        path: "/ilink/bot/sendmessage",
        tokenMatchesExpected: true,
        tokenLooksPlaceholder: false,
        tokenRedacted: true,
        targetMatchesExpected: true,
        textMatchesExpected: true,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
