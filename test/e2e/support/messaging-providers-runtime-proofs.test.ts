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

import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
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
  SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
} from "../live/messaging-providers-slack-runtime-proof.ts";
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

function optionValues(args: string[], option: string): string[] {
  return args.flatMap((argument, index) => (argument === option ? [args[index + 1]!] : []));
}

function optionValue(args: string[], option: string): string {
  return optionValues(args, option)[0]!;
}

function fakePublishedPorts(containerPorts: readonly number[], hostAddress: string) {
  return Object.fromEntries(
    containerPorts.map((containerPort) => {
      const hostPort =
        containerPort === 8081 ? "32101" : containerPort === 8080 ? "32100" : "32079";
      return [String(containerPort) + "/tcp", [{ HostIp: hostAddress, HostPort: hostPort }]];
    }),
  );
}

function fakeDockerInspect(
  calls: string[][],
  options: {
    apiPublished: boolean;
    proxyContainerPorts: readonly number[];
    publishedAddress: string;
  },
): string {
  const [apiRun, proxyRun] = calls.filter((call) => call[0] === "run") as [string[], string[]];
  const apiContainer = optionValue(apiRun, "--name");
  const proxyContainer = optionValue(proxyRun, "--name");
  const network = optionValue(apiRun, "--network");
  return JSON.stringify([
    {
      Name: "/" + apiContainer,
      HostConfig: {},
      NetworkSettings: {
        Networks: { [network]: {} },
        Ports: options.apiPublished ? fakePublishedPorts([8080], "0.0.0.0") : {},
      },
    },
    {
      Name: "/" + proxyContainer,
      HostConfig: {
        CapDrop: ["ALL"],
        PidsLimit: 32,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
      },
      NetworkSettings: {
        Networks: { bridge: {}, [network]: {} },
        Ports: fakePublishedPorts(options.proxyContainerPorts, options.publishedAddress),
      },
    },
  ]);
}

function fakeDockerHost(
  options: {
    apiPublished?: boolean;
    proxyContainerPorts?: readonly number[];
    publishedAddress?: string;
    networkInspect?: string;
    proxyRunning?: boolean;
    proxyReady?: boolean;
  } = {},
): {
  calls: string[][];
  commands: Array<{ command: string; args: string[] }>;
  host: HostCliClient;
  setProxyRunning: (running: boolean) => void;
} {
  const calls: string[][] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const publishedAddress = options.publishedAddress ?? OPENSHELL_BRIDGE_ADDRESS;
  const networkInspect = options.networkInspect ?? OPENSHELL_NETWORK_INSPECT;
  const proxyContainerPorts = options.proxyContainerPorts ?? [FAKE_API_PROXY_READINESS_PORT, 8080];
  let proxyRunning = options.proxyRunning !== false;
  const dockerCommand = (args: string[]) => {
    const executedArgs = [...args];
    calls.push(executedArgs);
    return executedArgs[0] === "network" && executedArgs[1] === "inspect"
      ? successfulCommand(
          executedArgs[2] === "openshell-docker"
            ? networkInspect
            : JSON.stringify([{ Driver: "bridge", Internal: true }]),
        )
      : executedArgs[0] === "inspect"
        ? executedArgs[1] === "--format"
          ? executedArgs[2] === "{{json .State}}"
            ? successfulCommand(`${JSON.stringify({ Running: proxyRunning })}\n`)
            : successfulCommand(`${String(proxyRunning)}\n`)
          : successfulCommand(
              fakeDockerInspect(calls, {
                apiPublished: options.apiPublished === true,
                proxyContainerPorts,
                publishedAddress,
              }),
            )
        : executedArgs[0] === "logs"
          ? successfulCommand("proxy fixture stopped\n")
          : executedArgs[0] === "port"
            ? successfulCommand(
                `${publishedAddress}:${
                  executedArgs[2] === "8081/tcp"
                    ? "32101"
                    : executedArgs[2] === `${String(FAKE_API_PROXY_READINESS_PORT)}/tcp`
                      ? "32079"
                      : "32100"
                }\n`,
              )
            : successfulCommand();
  };
  const host = {
    command: async (command: string, args: string[]) => {
      commands.push({ command, args: [...args] });
      expect(["docker", "node"]).toContain(command);
      return command === "node"
        ? options.proxyReady === false
          ? failedCommand("proxy could not reach the upstream API")
          : successfulCommand()
        : dockerCommand(args);
    },
  } as unknown as HostCliClient;
  return {
    calls,
    commands,
    host,
    setProxyRunning: (running) => {
      proxyRunning = running;
    },
  };
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

  it("returns distinct Slack REST and websocket ports from accepted Docker state", async () => {
    const { host } = fakeDockerHost({
      proxyContainerPorts: [FAKE_API_PROXY_READINESS_PORT, 8080, 8081],
    });
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

  it("relays both configured ports and proves upstream readiness through the real proxy", async () => {
    const upstreamAddress = "127.0.0.1";
    const proxyAddress = "127.0.0.1";
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
    const proxy = spawn(process.execPath, ["-e", FAKE_API_PROXY_SOURCE], {
      env: {
        ...process.env,
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
    const { calls, host } = fakeDockerHost({ proxyRunning: false });
    const cleanup: CleanupAction[] = [];
    let failure: unknown;

    try {
      await startFakeDiscordApi(host, cleanup);
    } catch (error) {
      failure = error;
    } finally {
      await runCleanup(cleanup);
    }

    const runCalls = calls.filter((args) => args[0] === "run");
    expect(runCalls).toHaveLength(2);
    const [apiRun, proxyRun] = runCalls as [string[], string[]];
    const apiContainer = apiRun[apiRun.indexOf("--name") + 1]!;
    const proxyContainer = proxyRun[proxyRun.indexOf("--name") + 1]!;
    const networkCreate = calls.find((args) => args[0] === "network" && args[1] === "create");
    const network = networkCreate?.at(-1);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(proxyContainer);
    expect(calls).toContainEqual(["inspect", "--format", "{{json .State}}", proxyContainer]);
    expect(calls).toContainEqual(["logs", "--tail", "100", proxyContainer]);
    expect(calls).toContainEqual(["rm", "-f", proxyContainer]);
    expect(calls).toContainEqual(["rm", "-f", apiContainer]);
    expect(calls).toContainEqual(["network", "rm", network]);
  });

  it("fails with API and proxy diagnostics when the proxy cannot reach the API", async () => {
    const { calls, host } = fakeDockerHost({ proxyReady: false });
    const cleanup: CleanupAction[] = [];
    let failure: unknown;

    try {
      await startFakeDiscordApi(host, cleanup);
    } catch (error) {
      failure = error;
    } finally {
      await runCleanup(cleanup);
    }

    const runCalls = calls.filter((args) => args[0] === "run");
    expect(runCalls).toHaveLength(2);
    const [apiRun, proxyRun] = runCalls as [string[], string[]];
    const apiContainer = apiRun[apiRun.indexOf("--name") + 1]!;
    const proxyContainer = proxyRun[proxyRun.indexOf("--name") + 1]!;
    const networkCreate = calls.find((args) => args[0] === "network" && args[1] === "create");
    const network = networkCreate?.at(-1);
    const stateDiagnostics = ["inspect", "--format", "{{json .State}}", proxyContainer];
    const logDiagnostics = ["logs", "--tail", "100", proxyContainer];
    const apiStateDiagnostics = ["inspect", "--format", "{{json .State}}", apiContainer];
    const apiLogDiagnostics = ["logs", "--tail", "100", apiContainer];
    const countCalls = (expected: string[]): number =>
      calls.filter((args) => JSON.stringify(args) === JSON.stringify(expected)).length;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(proxyContainer);
    expect(calls).toContainEqual(["inspect", "--format", "{{.State.Running}}", proxyContainer]);
    expect(countCalls(stateDiagnostics)).toBe(1);
    expect(countCalls(logDiagnostics)).toBe(1);
    expect(countCalls(apiStateDiagnostics)).toBe(1);
    expect(countCalls(apiLogDiagnostics)).toBe(1);
    expect(calls).toContainEqual(["rm", "-f", proxyContainer]);
    expect(calls).toContainEqual(["rm", "-f", apiContainer]);
    expect(calls).toContainEqual(["network", "rm", network]);
  });

  it("captures proxy diagnostics before cleanup after a post-readiness stop", async () => {
    const { calls, host, setProxyRunning } = fakeDockerHost();
    const cleanup: CleanupAction[] = [];

    try {
      await startFakeDiscordApi(host, cleanup);
      setProxyRunning(false);
    } finally {
      await runCleanup(cleanup);
    }

    const runCalls = calls.filter((args) => args[0] === "run");
    expect(runCalls).toHaveLength(2);
    const [apiRun, proxyRun] = runCalls as [string[], string[]];
    const proxyContainer = proxyRun[proxyRun.indexOf("--name") + 1]!;
    const stateDiagnostics = ["inspect", "--format", "{{json .State}}", proxyContainer];
    const logDiagnostics = ["logs", "--tail", "100", proxyContainer];
    const removeProxy = ["rm", "-f", proxyContainer];
    const stateDiagnosticsIndex = calls.findIndex(
      (args) => JSON.stringify(args) === JSON.stringify(stateDiagnostics),
    );
    const logDiagnosticsIndex = calls.findIndex(
      (args) => JSON.stringify(args) === JSON.stringify(logDiagnostics),
    );
    const removeProxyIndex = calls.findIndex(
      (args) => JSON.stringify(args) === JSON.stringify(removeProxy),
    );

    expect(apiRun).not.toContain("--rm");
    expect(proxyRun).not.toContain("--rm");
    expect(calls).toContainEqual(stateDiagnostics);
    expect(calls).toContainEqual(logDiagnostics);
    expect(stateDiagnosticsIndex).toBeLessThan(removeProxyIndex);
    expect(logDiagnosticsIndex).toBeLessThan(removeProxyIndex);
    expect(calls).toContainEqual(removeProxy);
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
