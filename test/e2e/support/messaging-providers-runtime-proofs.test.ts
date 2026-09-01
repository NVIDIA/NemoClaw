// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policyOwner from "../../../src/lib/policy/index.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  applyCredentialBoundFakePolicy,
  buildSandboxNodeInvocation,
  buildSandboxShellInvocation,
  countJsonLines,
  type FakeDockerApi,
  FAKE_API_PROXY_READINESS_PORT,
  FAKE_API_PROXY_READINESS_SOURCE,
  FAKE_API_PROXY_SOURCE,
  isNvidiaEndpointRateLimitFailure,
  messagingEnv,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  parseRuntimeProofPort,
  precleanMessagingResources,
  REPO_ROOT,
  registerRetainedSandboxPolicyRestore,
  startFakeDockerApi,
} from "../live/messaging-providers-helpers.ts";
import {
  parseInstalledSlackProof,
  SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
} from "../live/messaging-providers-slack-runtime-proof.ts";
import { parseInstalledWechatProof } from "../live/messaging-providers-wechat-runtime-proof.ts";

const FAKE_TELEGRAM_API = path.resolve(import.meta.dirname, "../lib/fake-telegram-api.cjs");
const FAKE_SLACK_API = path.resolve(import.meta.dirname, "../lib/fake-slack-api.cjs");
const FAKE_WECHAT_API = path.resolve(import.meta.dirname, "../lib/fake-wechat-api.mts");
type CleanupAction = {
  name: string;
  run: () => Promise<void>;
};

const PRECLEAN_DENIAL_CASES: Array<[string, string[]]> = [
  ["nemoclaw", ["nemoclaw"]],
  ["openshell-sandbox", ["nemoclaw", "openshell-sandbox"]],
  ["openshell-gateway", ["nemoclaw", "openshell-sandbox", "openshell-gateway"]],
];

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
  },
): string {
  const [apiRun, proxyRun] = calls.filter((call) => call[0] === "run") as [string[], string[]];
  const apiContainer = optionValue(apiRun, "--name");
  const proxyContainer = optionValue(proxyRun, "--name");
  const apiNetwork = optionValue(apiRun, "--network");
  const connectedProxyNetworks = calls
    .filter((call) => call[0] === "network" && call[1] === "connect" && call[3] === proxyContainer)
    .map((call) => call[2]!);
  const proxyNetworks = [optionValue(proxyRun, "--network"), ...connectedProxyNetworks].filter(
    (network) => options.missingProxyControl !== "internal-network" || network !== apiNetwork,
  );
  return JSON.stringify([
    {
      Name: "/" + apiContainer,
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
      Config: {
        Env: [...optionValues(proxyRun, "-e"), ...options.proxyEnvironment],
      },
      Name: "/" + proxyContainer,
      HostConfig: {
        CapDrop:
          options.missingProxyControl === "--cap-drop" ? [] : optionValues(proxyRun, "--cap-drop"),
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
  envFiles: Array<{ path: string; source: string }>;
  host: HostCliClient;
  resources: () => { containers: string[]; networks: string[] };
  setProxyRunning: (running: boolean) => void;
} {
  const artifacts = new Map<string, string>();
  const calls: string[][] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const envFiles: Array<{ path: string; source: string }> = [];
  const containers = new Set<string>();
  const networks = new Set<string>();
  const networkInspect = options.networkInspect ?? OPENSHELL_NETWORK_INSPECT;
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
                    { Driver: "bridge", Internal: createdNetwork?.includes("--internal") === true },
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
        (executedArgs.includes("--env-file") ? [executedArgs] : []).forEach((runArgs) => {
          const envFile = runArgs[runArgs.indexOf("--env-file") + 1]!;
          envFiles.push({ path: envFile, source: fs.readFileSync(envFile, "utf8") });
        });
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
      expect(["docker", "node"]).toContain(command);
      const result =
        command === "node"
          ? options.proxyReady === false
            ? failedCommand("proxy could not reach the upstream API")
            : successfulCommand()
          : dockerCommand(args);
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
    envFiles,
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

function startFakeDiscordApi(host: HostCliClient, cleanup: CleanupAction[]) {
  return startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
    kind: "discord-gateway",
    imageScript: "fake-discord-gateway.cjs",
    containerPrefix: "fake-discord-gateway",
    portEnv: "FAKE_DISCORD_GATEWAY_PORT",
    captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
    expectedEnv: { FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: "fixture-discord-token" },
    redactionValues: ["fixture-discord-token"],
    env: {},
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
  it("counts only matching upstream capture rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-captures-"));
    const captureFile = path.join(dir, "capture.jsonl");
    const isSlackAuthCapture = (row: Record<string, unknown>): boolean =>
      row.event === "request" && row.path === "/api/auth.test";

    try {
      fs.writeFileSync(
        captureFile,
        [
          JSON.stringify({ event: "ready" }),
          JSON.stringify({ event: "request", path: "/api/auth.test" }),
          JSON.stringify({ event: "request", path: "/api/apps.connections.open" }),
        ].join("\n"),
      );

      expect(countJsonLines(captureFile, isSlackAuthCapture)).toBe(1);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(PRECLEAN_DENIAL_CASES)(
    "stops installation when %s cleanup is denied",
    async (deniedStage, expectedStages) => {
      const sandboxName = "e2e-messaging-cleanup";
      const artifactPrefix = "cleanup-messaging";
      const calls: string[] = [];
      const allowed = async (): Promise<void> => undefined;
      const outcomes = new Map<string, () => Promise<void>>([
        [
          deniedStage,
          async () => Promise.reject(new Error(`permission denied during ${deniedStage} cleanup`)),
        ],
      ]);
      const record = async (stage: string, name: string, artifactName: unknown): Promise<void> => {
        calls.push(`${stage}:${name}:${String(artifactName)}`);
        await (outcomes.get(stage) ?? allowed)();
      };
      const host: Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox"> = {
        cleanupSandbox: async (name, options) => record("nemoclaw", name, options?.artifactName),
        cleanupGatewayRegistration: async (name, options) =>
          record("openshell-gateway", name, options?.artifactName),
      };
      const sandbox: Pick<SandboxClient, "cleanupSandbox"> = {
        cleanupSandbox: async (name, options) =>
          record("openshell-sandbox", name, options?.artifactName),
      };
      const expectedByStage: Record<string, string> = {
        nemoclaw: `nemoclaw:${sandboxName}:${artifactPrefix}-nemoclaw-destroy`,
        "openshell-sandbox": `openshell-sandbox:${sandboxName}:${artifactPrefix}-openshell-sandbox-delete`,
        "openshell-gateway": `openshell-gateway:nemoclaw:${artifactPrefix}-openshell-gateway-destroy`,
      };
      let installAttempted = false;

      await expect(
        (async () => {
          await precleanMessagingResources(host, sandbox, {
            sandboxName,
            artifactPrefix,
            env: {},
            redactionValues: [],
          });
          installAttempted = true;
        })(),
        "cleanup should fail closed",
      ).rejects.toThrow(`permission denied during ${deniedStage} cleanup`);

      expect(calls).toEqual(expectedStages.map((stage) => expectedByStage[stage]));
      expect(installAttempted).toBe(false);
    },
  );

  it("restores a retained sandbox policy before removing its fake API", async () => {
    const sandboxName = "e2e-hermes-discord";
    const baseline = YAML.stringify({
      version: 1,
      network_policies: {
        discord: { endpoints: [{ host: "discord.com", port: 443, protocol: "rest" }] },
      },
    });
    const events: string[] = [];
    let policyReads = 0;
    const sandbox = {
      openshell: async () => {
        policyReads += 1;
        events.push(policyReads === 1 ? "capture-policy" : "verify-policy");
        return successfulCommand(baseline);
      },
    } as unknown as Pick<SandboxClient, "openshell">;
    const cleanup = new CleanupRegistry();
    cleanup.add("remove fake API", async () => {
      events.push("remove-fake-api");
    });
    const restore = vi.spyOn(policyOwner, "setPolicyDocument").mockImplementation(() => {
      events.push("restore-policy");
      return true;
    });

    try {
      await registerRetainedSandboxPolicyRestore(cleanup, sandbox, {
        keepSandbox: true,
        sandboxName,
        env: {},
        redactionValues: [],
      });
      const result = await cleanup.runAll();

      expect(result.failures).toEqual([]);
      expect(result.passed).toEqual([
        `restore retained sandbox policy ${sandboxName}`,
        "remove fake API",
      ]);
      expect(events).toEqual([
        "capture-policy",
        "restore-policy",
        "verify-policy",
        "remove-fake-api",
      ]);
      expect(restore).toHaveBeenCalledWith(
        sandboxName,
        expect.any(String),
        expect.objectContaining({
          nonFatal: true,
          operation: expect.stringContaining("before fake API cleanup"),
        }),
      );
      expect(YAML.parse(restore.mock.calls[0]![1])).toEqual(YAML.parse(baseline));
    } finally {
      restore.mockRestore();
    }
  });

  it.each([
    {
      protocol: "rest" as const,
      rewrite: "request-body-credential-rewrite" as const,
      allowRules: [
        "host.openshell.internal:43117:GET:/**",
        "host.openshell.internal:43117:POST:/**",
      ],
      binaries: ["/usr/local/bin/node", "/usr/bin/node"],
    },
    {
      protocol: "websocket" as const,
      rewrite: "websocket-credential-rewrite" as const,
      allowRules: [
        "host.openshell.internal:43117:GET:/**",
        "host.openshell.internal:43117:WEBSOCKET_TEXT:/**",
      ],
      policyHost: "host.openshell.internal",
      binaries: ["/opt/hermes/.venv/bin/python"],
    },
  ])(
    "when a $protocol fake endpoint is bound, one policy owner retains update arguments and invokes the reconciled transaction",
    async ({ protocol, rewrite, allowRules, policyHost, binaries }) => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const host = {
        openshellCommandPath: "/trusted/openshell",
        command: async (command: string, args: string[]) => {
          calls.push({ command, args });
          return successfulCommand();
        },
      } as unknown as HostCliClient;
      const port = "43117";

      await applyCredentialBoundFakePolicy({
        host,
        sandboxName: "e2e-messaging-policy",
        api: { port } as FakeDockerApi,
        protocol,
        rewrite,
        providerName: "e2e-messaging-policy-bridge",
        env: {},
        redactions: [],
        artifactName: `apply-${protocol}-policy`,
        policyHost,
        binaries,
      });

      expect(calls).toHaveLength(2);
      const update = calls[0]!;
      expect(update.command).toBe("/trusted/openshell");
      const expectedHost = policyHost ?? "host.openshell.internal";
      expect(update.args).toContain(
        `${expectedHost}:${port}:read-write:${protocol}:enforce:${rewrite},allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
      );
      expect(update.args).toEqual(expect.arrayContaining([...allowRules, ...binaries]));
      expect(update.args.at(-1)).toBe("--wait");

      const binding = calls[1]!;
      expect(binding.command).toBe(process.execPath);
      expect(binding.args).toContain("e2e-messaging-policy-bridge");
      expect(binding.args).toContain(expectedHost);
      expect(binding.args).toContain(protocol);
      expect(binding.args).toEqual(
        expect.arrayContaining([
          "enforce",
          rewrite,
          protocol === "rest" ? "GET,POST" : "GET,WEBSOCKET_TEXT",
          "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
          ...binaries,
        ]),
      );
      expect(binding.args).toContain(
        path.join(REPO_ROOT, "test/e2e/fixtures/credential-policy-transaction.ts"),
      );
    },
  );

  it("keeps a fake API expected credential out of Docker argv and removes its env file", async () => {
    const sentinel = "xoxb-nemoclaw-docker-argv-secret";
    const encoded = Buffer.from(sentinel, "utf8").toString("base64");
    const { calls, envFiles, host } = fakeDockerHost();
    const cleanup: CleanupAction[] = [];
    let envFile = "";

    try {
      const api = await startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
        kind: "discord-gateway",
        imageScript: "fake-discord-gateway.cjs",
        containerPrefix: "fake-discord-gateway",
        portEnv: "FAKE_API_PORT",
        captureFileEnv: "FAKE_API_CAPTURE_FILE",
        expectedEnv: { FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: sentinel },
        redactionValues: [sentinel],
        env: {},
      });
      const dockerArgv = JSON.stringify(calls);
      expect(dockerArgv).not.toContain(sentinel);
      expect(dockerArgv).not.toContain(encoded);
      const apiRun = calls.find((call) => call[0] === "run" && call.includes("--env-file"));
      expect(apiRun).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "32",
        ]),
      );
      expect(optionValues(apiRun!, "-p")).toEqual([]);
      expect(api.port).toBe("32100");
      expect(envFiles).toHaveLength(1);
      expect(envFiles[0]?.source).toBe(`FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN=${sentinel}`);
      envFile = envFiles[0]!.path;
      expect(envFile).not.toBe("");
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    } finally {
      await runCleanup(cleanup);
    }

    expect(fs.existsSync(envFile)).toBe(false);
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
    let credentialDir: string | undefined;

    try {
      await expect(startFakeDiscordApi(host, cleanup)).rejects.toThrow(
        /exactly one IPv4 bridge gateway/u,
      );
      expect(calls).toEqual([["network", "inspect", "openshell-docker"]]);
      expect(cleanup).toHaveLength(2);
      fixtureDir = cleanup[0]!.name.replace(/^remove /u, "");
      credentialDir = cleanup[1]!.name.replace(/^remove /u, "");
      expect(fs.existsSync(fixtureDir)).toBe(true);
      expect(fs.existsSync(credentialDir)).toBe(true);
    } finally {
      await runCleanup(cleanup);
    }
    expect(fixtureDir).toBeDefined();
    expect(credentialDir).toBeDefined();
    expect(fs.existsSync(fixtureDir!)).toBe(false);
    expect(fs.existsSync(credentialDir!)).toBe(false);
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

    expect(
      Math.max(...invocation.map((argument) => Buffer.byteLength(argument, "utf8"))),
    ).toBeLessThan(OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES);
    expect(invocation.filter((argument) => /[\r\n]/u.test(argument))).toEqual([]);
    const [command, ...args] = invocation;
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(source);
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
        SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
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
