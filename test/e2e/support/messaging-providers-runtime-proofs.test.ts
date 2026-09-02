// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { CommandRunner } from "../fixtures/clients/command.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import { bindPolicyEndpoints } from "../fixtures/policy-credential-binding.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import { superviseChild } from "../fixtures/shell/supervisor.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  applyFakeApiPolicy,
  buildSandboxNodeInvocation,
  buildSandboxShellInvocation,
  isNvidiaEndpointRateLimitFailure,
  messagingEnv,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  parseRuntimeProofPort,
  rawTokenSurfaceProbe,
  runSecondaryCleanup,
  startFakeDockerApi,
  SYNTHETIC_FAKE_API_CREDENTIALS,
} from "../live/messaging-providers-helpers.ts";
import {
  parseInstalledSlackProof,
  SLACK_MANAGED_NPM_PROJECT_DISCOVERY_SOURCE,
} from "../live/messaging-providers-slack-runtime-proof.ts";
import {
  parseInstalledWechatProof,
  WECHAT_INSTALLED_PLUGIN_DISCOVERY_SOURCE,
} from "../live/messaging-providers-wechat-runtime-proof.ts";

const FAKE_TELEGRAM_API = path.resolve(import.meta.dirname, "../lib/fake-telegram-api.cjs");
const FAKE_SLACK_API = path.resolve(import.meta.dirname, "../lib/fake-slack-api.cjs");
const FAKE_WECHAT_API = path.resolve(import.meta.dirname, "../lib/fake-wechat-api.mts");
const FAKE_DISCORD_GATEWAY = path.resolve(import.meta.dirname, "../lib/fake-discord-gateway.cjs");
const FAKE_API_PORT_TRAFFIC = path.resolve(
  import.meta.dirname,
  "../lib/fake-api-port-readiness.mts",
);
const FAKE_SLACK_APP_TOKEN = "xapp-fake-slack-port-test";
const FAKE_SLACK_BOT_TOKEN = "xoxb-fake-slack-port-test";
const STDERR_TAIL_LIMIT = 4_096;
const OPENSHELL_BRIDGE_ADDRESS = "172.18.0.1";
const OPENSHELL_NETWORK_INSPECT = JSON.stringify([
  {
    Driver: "bridge",
    IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: OPENSHELL_BRIDGE_ADDRESS }] },
  },
]);

async function waitFor(predicate: () => boolean, message: string | (() => string)): Promise<void> {
  await vi.waitFor(
    () => {
      expect(predicate(), typeof message === "string" ? message : message()).toBe(true);
    },
    { interval: 25, timeout: 5_000 },
  );
}

function successfulShellResult(command: string[], stdout = ""): ShellProbeResult {
  return {
    command,
    durationMs: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

type FakeSlackPortFixture = {
  restPort: number;
  websocketPort: number;
  captureFile: string;
  stop: () => Promise<void>;
};

type FakePortFixture = {
  restPort: number;
  websocketPort?: number;
  captureFile: string;
  stop: () => Promise<void>;
};

function readFakeSlackCapture(captureFile: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function startFakePortFixture(options: {
  label: string;
  script: string;
  nodeArgs?: string[];
  env: (portFile: string, captureFile: string) => NodeJS.ProcessEnv;
  redactionValues?: string[];
  websocketPort?: (captureFile: string) => number;
}): Promise<FakePortFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-api-ports-"));
  const portFile = path.join(dir, "port");
  const captureFile = path.join(dir, "capture.jsonl");
  const progress = startTestProgress(
    options.label,
    ["start fake API listeners", "exercise port traffic"],
    { logLine: () => undefined },
  );
  const controller = new AbortController();
  const child = spawnObservedChild(
    process.execPath,
    [...(options.nodeArgs ?? []), options.script],
    {
      activityLabel: `command: ${options.label}`,
      progress,
      spawn: {
        detached: true,
        env: {
          PATH: process.env.PATH ?? "",
          ...options.env(portFile, captureFile),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    },
  );
  let stderrTail = "";
  const supervised = superviseChild(child, {
    timeoutMs: 30_000,
    killGraceMs: 1_000,
    signal: controller.signal,
    onStderr: (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    },
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      controller.abort();
      const result = await supervised;
      progress.stop(result.spawnError || result.timedOut ? "failed" : "passed");
      fs.rmSync(dir, { recursive: true, force: true });
    })();
    return stopPromise;
  };

  try {
    await waitFor(
      () => fs.existsSync(portFile),
      () =>
        `${options.label} did not start: ${redactString(stderrTail, options.redactionValues ?? [])}`,
    );
    const restPort = parseRuntimeProofPort(fs.readFileSync(portFile, "utf8").trim());
    const websocketPort = options.websocketPort?.(captureFile);
    progress.phase("exercise port traffic");
    return { restPort, websocketPort, captureFile, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startFakeSlackPortFixture(options?: {
  suppressPortTrafficReply?: boolean;
  restPortTrafficStatus?: number;
  restPortTrafficReply?: string;
}): Promise<FakeSlackPortFixture> {
  const fixture = await startFakePortFixture({
    label: "fake Slack port fixture",
    script: FAKE_SLACK_API,
    redactionValues: [FAKE_SLACK_APP_TOKEN, FAKE_SLACK_BOT_TOKEN],
    env: (portFile, captureFile) => ({
      FAKE_SLACK_API_HOST: "127.0.0.1",
      FAKE_SLACK_API_PORT: "0",
      FAKE_SLACK_API_WEBSOCKET_PORT: "0",
      FAKE_SLACK_API_PORT_FILE: portFile,
      FAKE_SLACK_API_CAPTURE_FILE: captureFile,
      FAKE_SLACK_API_EXPECTED_BOT_TOKEN: FAKE_SLACK_BOT_TOKEN,
      FAKE_SLACK_API_EXPECTED_APP_TOKEN: FAKE_SLACK_APP_TOKEN,
      ...(options?.suppressPortTrafficReply
        ? { FAKE_SLACK_API_SUPPRESS_PORT_TRAFFIC_REPLY: "1" }
        : {}),
      ...(options?.restPortTrafficStatus === undefined
        ? {}
        : { FAKE_SLACK_API_PORT_TRAFFIC_STATUS: String(options.restPortTrafficStatus) }),
      ...(options?.restPortTrafficReply === undefined
        ? {}
        : { FAKE_SLACK_API_PORT_TRAFFIC_REPLY: options.restPortTrafficReply }),
    }),
    websocketPort: (captureFile) =>
      Number(
        readFakeSlackCapture(captureFile).find((entry) => entry.kind === "websocket")?.port ?? 0,
      ),
  });
  const websocketPort = fixture.websocketPort;
  expect(websocketPort).toBeGreaterThan(0);
  return { ...fixture, websocketPort: websocketPort as number };
}

function runPortTrafficCheck(restPort: number, websocketPort?: number) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      FAKE_API_PORT_TRAFFIC,
      "127.0.0.1",
      String(restPort),
      ...(websocketPort === undefined ? [] : [String(websocketPort)]),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
}

function runFakeSlackPortTrafficCheck(fixture: FakeSlackPortFixture) {
  return runPortTrafficCheck(fixture.restPort, fixture.websocketPort);
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

function fakeDockerHost(
  publishedAddress = OPENSHELL_BRIDGE_ADDRESS,
  calls: string[][] = [],
  networkInspect = OPENSHELL_NETWORK_INSPECT,
  proxyOnDefaultBridge = false,
): HostCliClient {
  let privateNetwork = "";
  let proxyContainer = "";
  let proxyPrimaryNetwork = "";
  let proxyConnectedToInternal = false;
  const host = {
    command: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      switch (command) {
        case "node":
          return successfulCommand();
        default:
          expect(command).toBe("docker");
          switch (args[0]) {
            case "network":
              switch (args[1]) {
                case "inspect":
                  return successfulCommand(networkInspect);
                case "create":
                  privateNetwork = args.includes("--internal")
                    ? (args.at(-1) ?? "")
                    : privateNetwork;
                  return successfulCommand();
                case "connect":
                  proxyConnectedToInternal =
                    args[2] === privateNetwork && args[3] === proxyContainer;
                  return successfulCommand();
                default:
                  return successfulCommand();
              }
            case "run":
              const startsProxy = args.some((argument) =>
                argument.startsWith("NEMOCLAW_FAKE_API_UPSTREAM="),
              );
              proxyContainer = startsProxy
                ? (args[args.indexOf("--name") + 1] ?? "")
                : proxyContainer;
              proxyPrimaryNetwork = startsProxy
                ? (args[args.indexOf("--network") + 1] ?? "")
                : proxyPrimaryNetwork;
              args
                .filter((argument) => argument.endsWith(":/tmp/fake"))
                .forEach((fakeApiMount) => {
                  const fixtureDir = fakeApiMount.slice(0, -":/tmp/fake".length);
                  fs.writeFileSync(path.join(fixtureDir, "port"), "8080");
                });
              return successfulCommand();
            case "inspect":
              return args[2] === "{{json .NetworkSettings.Networks}}"
                ? successfulCommand(
                    JSON.stringify(
                      args.at(-1) === proxyContainer
                        ? {
                            ...(proxyOnDefaultBridge ? { bridge: {} } : {}),
                            [proxyPrimaryNetwork]: {},
                            ...(proxyConnectedToInternal ? { [privateNetwork]: {} } : {}),
                          }
                        : { [privateNetwork]: {} },
                    ),
                  )
                : successfulCommand(
                    JSON.stringify([
                      "PATH=/usr/local/bin:/usr/bin:/bin",
                      "NEMOCLAW_FAKE_API_UPSTREAM=fake-api",
                      "NEMOCLAW_FAKE_API_PROXY_PORTS=8080",
                    ]),
                  );
            case "port":
              return successfulCommand(
                args[2]
                  ? `${publishedAddress}:${args[2] === "8081/tcp" ? "32101" : "32100"}\n`
                  : "",
              );
            default:
              return successfulCommand();
          }
      }
    },
  } as unknown as HostCliClient;
  return host;
}

describe("messaging provider installed-runtime proofs", () => {
  it("runs the shared raw-token probe against the caller's sandbox", async () => {
    const token = "raw-token-probe-must-not-enter-argv";
    let observedSandbox = "";
    let observedInvocation: string[] = [];
    let observedArtifact = "";
    const sandbox = {
      async exec(sandboxName: string, invocation: string[], options: { artifactName?: string }) {
        observedSandbox = sandboxName;
        observedInvocation = invocation;
        observedArtifact = options.artifactName ?? "";
        return successfulShellResult(["openshell", "sandbox", "exec"], "ABSENT\n");
      },
    } as unknown as SandboxClient;

    const output = await rawTokenSurfaceProbe(
      sandbox,
      "e2e-hermes-discord",
      token,
      "env",
      "hermes-raw-token-env",
      [token],
    );

    expect(output).toBe("ABSENT");
    expect(observedSandbox).toBe("e2e-hermes-discord");
    expect(observedArtifact).toBe("hermes-raw-token-env");
    expect(JSON.stringify(observedInvocation)).not.toContain(token);
  });

  it("accepts absent secondary cleanup results and reports other failures", async () => {
    const cleanupResult = (stderr: string, artifact: string): ShellProbeResult => ({
      ...successfulShellResult(["openshell", "sandbox", "delete", "fixture"]),
      exitCode: 1,
      stderr,
      artifacts: { stdout: "", stderr: "", result: artifact },
    });

    await expect(
      runSecondaryCleanup(async () => cleanupResult("Sandbox 'fixture' does not exist.", "")),
    ).resolves.toBeUndefined();
    await expect(
      runSecondaryCleanup(async () =>
        cleanupResult("permission denied", "artifacts/cleanup-failed.result.json"),
      ),
    ).rejects.toThrow(
      "secondary cleanup failed; see artifacts/cleanup-failed.result.json for redacted command output",
    );
  });

  it("produces mixed REST and WebSocket policy state through a minimal consumer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-api-policy-"));
    const policyFile = path.join(dir, "policy.yaml");
    const commands: Array<{ command: string; args: string[] }> = [];
    const consumer: CommandRunner = {
      async run(command) {
        const invocation = [command.command, ...command.args];
        commands.push({ command: command.command, args: [...command.args] });
        return successfulShellResult(invocation);
      },
    };

    try {
      const host = new HostCliClient(consumer, { openshellPath: "/opt/openshell" });
      await applyFakeApiPolicy({
        host,
        sandboxName: "e2e-slack-policy-owner",
        policyHost: "host.openshell.internal",
        endpoints: [
          {
            port: "43117",
            protocol: "rest",
            providerName: "e2e-slack-policy-owner-slack-bridge",
          },
          {
            port: "43118",
            protocol: "websocket",
            providerName: "e2e-slack-policy-owner-slack-app",
          },
        ],
        binaries: ["/usr/local/bin/node", "/usr/bin/node"],
        artifactName: "apply-slack-owner-policy",
        env: {},
        redactionValues: [],
      });

      const updateArgs = commands.find(({ command }) => command === "/opt/openshell")?.args ?? [];
      const endpointSpecs = updateArgs.flatMap((value, index) =>
        value === "--add-endpoint" ? [updateArgs[index + 1] ?? ""] : [],
      );
      const syntheticEndpoints = endpointSpecs.map((spec) => {
        const match =
          /^([^:]+):([1-9][0-9]*):read-write:(rest|websocket):enforce:(request-body-credential-rewrite|websocket-credential-rewrite)/u.exec(
            spec,
          );
        expect(match, "synthetic policy consumer accepted the endpoint").not.toBeNull();
        const [, host, rawPort, protocol, rewrite] = match!;
        return {
          host,
          port: Number(rawPort),
          protocol,
          ...(rewrite === "request-body-credential-rewrite"
            ? { request_body_credential_rewrite: true }
            : { websocket_credential_rewrite: true }),
        };
      });
      fs.writeFileSync(
        policyFile,
        YAML.stringify({
          version: 1,
          network_policies: { synthetic: { endpoints: syntheticEndpoints } },
        }),
      );
      const bindingArgs = commands.find(({ command }) => command === "bash")?.args ?? [];
      const rawBindings = bindingArgs.slice(-(syntheticEndpoints.length * 4));
      bindPolicyEndpoints(
        policyFile,
        Array.from({ length: syntheticEndpoints.length }, (_, index) => {
          const [providerName, host, rawPort, protocol] = rawBindings.slice(
            index * 4,
            index * 4 + 4,
          );
          return {
            providerName: providerName!,
            host: host!,
            port: Number(rawPort),
            protocol: protocol!,
          };
        }),
      );
      const endpoints = YAML.parse(fs.readFileSync(policyFile, "utf8")).network_policies.synthetic
        .endpoints;
      expect(endpoints).toEqual([
        {
          host: "host.openshell.internal",
          port: 43_117,
          protocol: "rest",
          request_body_credential_rewrite: true,
          credential_binding: { provider: "e2e-slack-policy-owner-slack-bridge" },
        },
        {
          host: "host.openshell.internal",
          port: 43_118,
          protocol: "websocket",
          websocket_credential_rewrite: true,
          credential_binding: { provider: "e2e-slack-policy-owner-slack-app" },
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects API diagnostics when the fake container does not become ready", async () => {
    vi.useFakeTimers();
    const artifactNames: string[] = [];
    const invocations: Array<{
      artifactName: string;
      command: string;
      args: readonly string[];
    }> = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    let container = "";
    const runner: CommandRunner = {
      async run(command, options) {
        const invocation = [command.command, ...command.args];
        const artifactName = options?.artifactName ?? "";
        artifactNames.push(...(artifactName ? [artifactName] : []));
        invocations.push({ artifactName, command: command.command, args: command.args });
        switch (artifactName) {
          case "inspect-fake-slack-openshell-network":
            return successfulShellResult(invocation, OPENSHELL_NETWORK_INSPECT);
          case "start-fake-slack-api":
            container = invocation[invocation.indexOf("--name") + 1] ?? "";
            break;
          default:
            break;
        }
        return successfulShellResult(invocation);
      },
    };

    try {
      const start = expect(
        startFakeDockerApi(new HostCliClient(runner), (_name, run) => cleanupTasks.push(run), {
          kind: "slack",
          imageScript: "fake-slack-api.cjs",
          containerPrefix: "nemoclaw-fake-slack-not-ready-test",
          portEnv: "FAKE_SLACK_API_PORT",
          portFileEnv: "FAKE_SLACK_API_PORT_FILE",
          captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
          credentialEnv: {
            FAKE_SLACK_API_EXPECTED_BOT_TOKEN: "xoxb-fake-slack-not-ready-test",
            FAKE_SLACK_API_EXPECTED_APP_TOKEN: "xapp-fake-slack-not-ready-test",
          },
          redactionValues: [],
          env: {},
        }),
      ).rejects.toThrow(/fake slack API container .* did not become ready/u);

      await vi.runAllTimersAsync();
      await start;
      expect(container).not.toBe("");
      const diagnostics = invocations.filter(({ artifactName }) =>
        artifactName.startsWith("failure-fake-slack-api-"),
      );
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          {
            artifactName: "failure-fake-slack-api-api-inspect",
            command: "docker",
            args: ["inspect", "--format", "{{json .State}}", container],
          },
          {
            artifactName: "failure-fake-slack-api-api-logs",
            command: "docker",
            args: ["logs", "--tail", "200", container],
          },
        ]),
      );
    } finally {
      vi.useRealTimers();
      await cleanupTasks
        .reverse()
        .reduce((previous, cleanupTask) => previous.then(cleanupTask), Promise.resolve());
    }

    expect(artifactNames).toContain(`cleanup-${container}`);
    expect(artifactNames).toContainEqual(
      expect.stringMatching(/^cleanup-nemoclaw-fake-api-network-/u),
    );
    expect(artifactNames).toContainEqual(
      expect.stringMatching(/^cleanup-nemoclaw-fake-api-publication-/u),
    );
  });

  it("collects diagnostics when published fake API proxy ports do not carry traffic", async () => {
    const invocations: Array<{
      artifactName: string;
      command: string;
      args: readonly string[];
    }> = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    let apiContainer = "";
    let proxyContainer = "";
    let network = "";
    let publicationNetwork = "";
    const runner: CommandRunner = {
      async run(command, options) {
        const invocation = [command.command, ...command.args];
        const artifactName = options?.artifactName ?? "";
        invocations.push({ artifactName, command: command.command, args: command.args });
        switch (artifactName) {
          case "inspect-fake-slack-openshell-network":
            return successfulShellResult(invocation, OPENSHELL_NETWORK_INSPECT);
          case "create-fake-slack-api-network":
            network = invocation.at(-1) ?? "";
            return successfulShellResult(invocation);
          case "create-fake-slack-api-publication-network":
            publicationNetwork = invocation.at(-1) ?? "";
            return successfulShellResult(invocation);
          case "start-fake-slack-api": {
            apiContainer = invocation[invocation.indexOf("--name") + 1] ?? "";
            const mountSuffix = ":/tmp/fake";
            const mount = invocation.find((argument) => argument.endsWith(mountSuffix));
            expect(mount).toBeDefined();
            fs.writeFileSync(path.join(mount!.slice(0, -mountSuffix.length), "port"), "8080\n");
            return successfulShellResult(invocation);
          }
          case "start-fake-slack-api-proxy":
            proxyContainer = invocation[invocation.indexOf("--name") + 1] ?? "";
            return successfulShellResult(invocation);
          case "prove-fake-slack-api-api-internal-network":
            return successfulShellResult(invocation, JSON.stringify({ [network]: {} }));
          case "prove-fake-slack-api-proxy-internal-network":
            return successfulShellResult(
              invocation,
              JSON.stringify({ [publicationNetwork]: {}, [network]: {} }),
            );
          case "prove-fake-slack-api-internal-only":
            return successfulShellResult(invocation);
          case "prove-fake-slack-api-proxy-credential-environment-free":
            return successfulShellResult(
              invocation,
              '["NEMOCLAW_FAKE_API_UPSTREAM=fake-api","NEMOCLAW_FAKE_API_PROXY_PORTS=8080,8081"]',
            );
          case "port-fake-slack-api":
            return successfulShellResult(invocation, `${OPENSHELL_BRIDGE_ADDRESS}:41080\n`);
          case "port-fake-slack-websocket-api":
            return successfulShellResult(invocation, `${OPENSHELL_BRIDGE_ADDRESS}:41081\n`);
          case "prove-fake-slack-api-proxy-traffic":
            return {
              ...successfulShellResult(invocation),
              exitCode: 1,
              stderr: "fake API port traffic check failed: connection refused",
            };
          default:
            return successfulShellResult(invocation);
        }
      },
    };

    try {
      await expect(
        startFakeDockerApi(new HostCliClient(runner), (_name, run) => cleanupTasks.push(run), {
          kind: "slack",
          imageScript: "fake-slack-api.cjs",
          containerPrefix: "nemoclaw-fake-slack-test",
          portEnv: "FAKE_SLACK_API_PORT",
          portFileEnv: "FAKE_SLACK_API_PORT_FILE",
          captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
          credentialEnv: {
            FAKE_SLACK_API_EXPECTED_BOT_TOKEN: "xoxb-fake-slack-network-test",
            FAKE_SLACK_API_EXPECTED_APP_TOKEN: "xapp-fake-slack-network-test",
          },
          redactionValues: [],
          env: {},
        }),
      ).rejects.toThrow(/proxy .* did not carry traffic to API container .*traffic check/u);
      expect(apiContainer).not.toBe("");
      expect(proxyContainer).not.toBe("");
      const diagnostics = invocations.filter(({ artifactName }) =>
        artifactName.startsWith("failure-fake-slack-api-"),
      );
      expect(diagnostics).toHaveLength(4);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          {
            artifactName: "failure-fake-slack-api-proxy-inspect",
            command: "docker",
            args: ["inspect", "--format", "{{json .State}}", proxyContainer],
          },
          {
            artifactName: "failure-fake-slack-api-proxy-logs",
            command: "docker",
            args: ["logs", "--tail", "200", proxyContainer],
          },
          {
            artifactName: "failure-fake-slack-api-api-inspect",
            command: "docker",
            args: ["inspect", "--format", "{{json .State}}", apiContainer],
          },
          {
            artifactName: "failure-fake-slack-api-api-logs",
            command: "docker",
            args: ["logs", "--tail", "200", apiContainer],
          },
        ]),
      );
    } finally {
      await cleanupTasks
        .reverse()
        .reduce((previous, cleanupTask) => previous.then(cleanupTask), Promise.resolve());
    }
  });

  it("rejects a fake API proxy port that Docker publishes beyond the OpenShell bridge", async () => {
    const host = fakeDockerHost("0.0.0.0");
    const cleanup: Array<() => Promise<void>> = [];

    try {
      await expect(
        startFakeDockerApi(host, (_name, run) => cleanup.push(run), {
          kind: "discord-gateway",
          imageScript: "fake-discord-gateway-api.cjs",
          containerPrefix: "fake-discord-gateway",
          portEnv: "FAKE_API_PORT",
          portFileEnv: "FAKE_API_PORT_FILE",
          captureFileEnv: "FAKE_API_CAPTURE_FILE",
          credentialEnv: {},
          redactionValues: [],
          env: {},
        }),
      ).rejects.toThrow(/did not bind only to the OpenShell bridge/u);
    } finally {
      await cleanup
        .reverse()
        .reduce((previous, action) => previous.then(action), Promise.resolve());
    }
  });

  it("keeps the API private while the credential-free proxy carries bridge traffic", async () => {
    const calls: string[][] = [];
    const host = fakeDockerHost(OPENSHELL_BRIDGE_ADDRESS, calls);
    const cleanup: Array<() => Promise<void>> = [];
    const cleanupNames: string[] = [];
    const sentinel = "test-fake-docker-state-token";

    try {
      const api = await startFakeDockerApi(
        host,
        (name, run) => {
          cleanupNames.push(name);
          cleanup.push(run);
        },
        {
          kind: "discord-gateway",
          imageScript: "fake-discord-gateway-api.cjs",
          containerPrefix: "fake-discord-gateway",
          portEnv: "FAKE_API_PORT",
          portFileEnv: "FAKE_API_PORT_FILE",
          captureFileEnv: "FAKE_API_CAPTURE_FILE",
          credentialEnv: { FAKE_API_EXPECTED_TOKEN: sentinel },
          redactionValues: [sentinel],
          env: {},
        },
      );
      expect(api.port).toBe("32100");
      const proxyRun = calls.find(
        (invocation) =>
          invocation[0] === "docker" &&
          invocation[1] === "run" &&
          invocation.some((argument) => argument.startsWith("NEMOCLAW_FAKE_API_UPSTREAM=")),
      );
      const proxyContainer = proxyRun?.[proxyRun.indexOf("--name") + 1] ?? "";
      expect(proxyContainer).not.toBe("");
      const inspect = async (container: string, template: string) => {
        const result = await host.command("docker", ["inspect", "--format", template, container]);
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout) as unknown;
      };
      const apiNetworks = Object.keys(
        (await inspect(api.container, "{{json .NetworkSettings.Networks}}")) as object,
      );
      const proxyNetworks = Object.keys(
        (await inspect(proxyContainer, "{{json .NetworkSettings.Networks}}")) as object,
      );
      expect(apiNetworks).toHaveLength(1);
      expect(proxyNetworks).toHaveLength(2);
      expect(proxyNetworks).toContain(apiNetworks[0]);
      expect(proxyNetworks).not.toContain("bridge");
      expect((await host.command("docker", ["port", api.container])).stdout.trim()).toBe("");
      expect(
        (await host.command("docker", ["port", proxyContainer, "8080/tcp"])).stdout.trim(),
      ).toBe(`${OPENSHELL_BRIDGE_ADDRESS}:32100`);
      const proxyEnvironment = (await inspect(proxyContainer, "{{json .Config.Env}}")) as string[];
      expect(proxyEnvironment.some((entry) => entry.includes("FAKE_API_EXPECTED_TOKEN"))).toBe(
        false,
      );
      expect(proxyEnvironment.some((entry) => entry.includes(sentinel))).toBe(false);
      expect(cleanupNames).toEqual([
        expect.stringMatching(/^remove nemoclaw-fake-api-network-/u),
        expect.stringMatching(/^remove nemoclaw-fake-api-publication-/u),
        expect.stringMatching(/^remove fake-discord-gateway-/u),
        expect.stringMatching(/^remove fake-discord-gateway-proxy-/u),
      ]);
    } finally {
      await cleanup
        .reverse()
        .reduce((previous, action) => previous.then(action), Promise.resolve());
    }
  });

  it("mounts fake API credentials without placing their values in Docker arguments", async () => {
    const calls: string[][] = [];
    const host = fakeDockerHost(OPENSHELL_BRIDGE_ADDRESS, calls);
    const cleanup: Array<() => Promise<void>> = [];
    const sentinel = "test-fake-credential-must-not-enter-docker-argv";
    let credentialFile = "";

    try {
      await startFakeDockerApi(host, (_name, run) => cleanup.push(run), {
        kind: "telegram",
        imageScript: "fake-telegram-api.cjs",
        containerPrefix: "fake-telegram-credential-file",
        portEnv: "FAKE_TELEGRAM_API_PORT",
        portFileEnv: "FAKE_TELEGRAM_API_PORT_FILE",
        captureFileEnv: "FAKE_TELEGRAM_API_CAPTURE_FILE",
        credentialEnv: { FAKE_TELEGRAM_API_EXPECTED_TOKEN: sentinel },
        redactionValues: [sentinel],
        env: {},
      });

      const apiRun = calls.find(
        (invocation) =>
          invocation[0] === "docker" &&
          invocation[1] === "run" &&
          !invocation.some((argument) => argument.startsWith("NEMOCLAW_FAKE_API_UPSTREAM=")),
      );
      expect(apiRun).toBeDefined();
      expect(JSON.stringify(apiRun)).not.toContain(sentinel);
      expect(apiRun).toContain(
        "FAKE_TELEGRAM_API_EXPECTED_TOKEN_FILE=/run/nemoclaw-fake-api-credentials/0",
      );
      const mountSuffix = ":/run/nemoclaw-fake-api-credentials/0:ro";
      const credentialMount = apiRun?.find((argument) => argument.endsWith(mountSuffix));
      expect(credentialMount).toBeDefined();
      credentialFile = credentialMount!.slice(0, -mountSuffix.length);
      const credentialFd = fs.openSync(
        credentialFile,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        expect(fs.fstatSync(credentialFd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(credentialFd, "utf8")).toBe(sentinel);
      } finally {
        fs.closeSync(credentialFd);
      }
    } finally {
      await cleanup
        .reverse()
        .reduce((previous, action) => previous.then(action), Promise.resolve());
    }
    expect(fs.existsSync(credentialFile)).toBe(false);
  });

  it("rejects a proxy that retains default-bridge egress", async () => {
    const host = fakeDockerHost(OPENSHELL_BRIDGE_ADDRESS, [], OPENSHELL_NETWORK_INSPECT, true);
    const cleanup: Array<() => Promise<void>> = [];

    try {
      await expect(
        startFakeDockerApi(host, (_name, run) => cleanup.push(run), {
          kind: "discord-gateway",
          imageScript: "fake-discord-gateway-api.cjs",
          containerPrefix: "fake-discord-gateway",
          portEnv: "FAKE_API_PORT",
          portFileEnv: "FAKE_API_PORT_FILE",
          captureFileEnv: "FAKE_API_CAPTURE_FILE",
          credentialEnv: {},
          redactionValues: [],
          env: {},
        }),
      ).rejects.toThrow(/proxy has unexpected network attachments/u);
    } finally {
      await cleanup
        .reverse()
        .reduce((previous, action) => previous.then(action), Promise.resolve());
    }
  });

  it("rejects an ambiguous configured OpenShell bridge before creating resources", async () => {
    const calls: string[][] = [];
    const networkInspect = JSON.stringify([
      {
        Driver: "bridge",
        IPAM: {
          Config: [{ Gateway: OPENSHELL_BRIDGE_ADDRESS }, { Gateway: "172.19.0.1" }],
        },
      },
    ]);
    const host = fakeDockerHost(OPENSHELL_BRIDGE_ADDRESS, calls, networkInspect);
    const cleanup: Array<() => Promise<void>> = [];

    await expect(
      startFakeDockerApi(host, (_name, run) => cleanup.push(run), {
        kind: "discord-gateway",
        imageScript: "fake-discord-gateway-api.cjs",
        containerPrefix: "fake-discord-gateway",
        portEnv: "FAKE_API_PORT",
        portFileEnv: "FAKE_API_PORT_FILE",
        captureFileEnv: "FAKE_API_CAPTURE_FILE",
        credentialEnv: {},
        redactionValues: [],
        env: { OPENSHELL_DOCKER_NETWORK_NAME: "configured-openshell-network" },
      }),
    ).rejects.toThrow(/exactly one IPv4 bridge gateway/u);
    expect(calls).toEqual([["docker", "network", "inspect", "configured-openshell-network"]]);
    expect(cleanup).toHaveLength(0);
  });

  it("uses synthetic credentials for every fake messaging API despite host tokens", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN_REAL", "host-real-telegram-token");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "host-telegram-token");
    vi.stubEnv("DISCORD_BOT_TOKEN_REAL", "host-real-discord-token");
    vi.stubEnv("DISCORD_BOT_TOKEN", "host-discord-token");
    vi.stubEnv("SLACK_BOT_TOKEN_REAL", "host-real-slack-bot-token");
    vi.stubEnv("SLACK_BOT_TOKEN", "host-slack-bot-token");
    vi.stubEnv("SLACK_APP_TOKEN_REAL", "host-real-slack-app-token");
    vi.stubEnv("SLACK_APP_TOKEN", "host-slack-app-token");
    vi.stubEnv("WECHAT_BOT_TOKEN", "host-wechat-token");
    try {
      const fixture = messagingEnv();
      const expected = SYNTHETIC_FAKE_API_CREDENTIALS.messagingProviders;
      expect(fixture.tokens).toMatchObject(expected);
      expect(fixture.env).toMatchObject({
        TELEGRAM_BOT_TOKEN: expected.telegram,
        DISCORD_BOT_TOKEN: expected.discord,
        SLACK_BOT_TOKEN: expected.slackBot,
        SLACK_APP_TOKEN: expected.slackApp,
        WECHAT_BOT_TOKEN: expected.wechat,
        NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
        NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1",
      });
      expect(SYNTHETIC_FAKE_API_CREDENTIALS).toMatchObject({
        hermesDiscord: "test-fake-discord-token-hermes-e2e",
        openClawDiscordPairing: "test-fake-discord-pairing-e2e",
        openClawSlackPairing: {
          bot: "xoxb-fake-slack-pairing-e2e",
          app: "xapp-fake-slack-pairing-e2e",
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a non-synthetic credential before creating fake API resources", async () => {
    const calls: string[][] = [];
    const host = fakeDockerHost(OPENSHELL_BRIDGE_ADDRESS, calls);
    const cleanup: Array<() => Promise<void>> = [];

    await expect(
      startFakeDockerApi(host, (_name, run) => cleanup.push(run), {
        kind: "telegram",
        imageScript: "fake-telegram-api.cjs",
        containerPrefix: "fake-telegram-real-credential",
        portEnv: "FAKE_TELEGRAM_API_PORT",
        portFileEnv: "FAKE_TELEGRAM_API_PORT_FILE",
        captureFileEnv: "FAKE_TELEGRAM_API_CAPTURE_FILE",
        credentialEnv: { FAKE_TELEGRAM_API_EXPECTED_TOKEN: "host-real-telegram-token" },
        redactionValues: [],
        env: {},
      }),
    ).rejects.toThrow(/credentials must use synthetic values/u);
    expect(calls).toEqual([["docker", "network", "inspect", "openshell-docker"]]);
    expect(cleanup).toHaveLength(0);
  });

  it("publishes independent fake Slack REST and websocket ports from one fixture", async () => {
    const fixture = await startFakeSlackPortFixture();

    try {
      expect(fixture.restPort).not.toBe(fixture.websocketPort);
      const listening = readFakeSlackCapture(fixture.captureFile).filter(
        (entry) => entry.event === "listening",
      );
      expect(listening).toHaveLength(2);
      expect(listening.map((entry) => entry.kind).sort()).toEqual(["rest", "websocket"]);
      expect(new Set(listening.map((entry) => entry.port)).size).toBe(2);
      const trafficCheck = runFakeSlackPortTrafficCheck(fixture);
      expect(trafficCheck.status, trafficCheck.stderr).toBe(0);
      const traffic = readFakeSlackCapture(fixture.captureFile);
      expect(traffic).toContainEqual(
        expect.objectContaining({ event: "request", path: "/__nemoclaw_e2e_port_traffic" }),
      );
      expect(traffic).toContainEqual(
        expect.objectContaining({ event: "websocket-upgrade", path: "/socket-mode" }),
      );
      expect(traffic).toContainEqual(
        expect.objectContaining({
          event: "websocket-message",
          messageType: "nemoclaw_port_traffic_probe",
          path: "/socket-mode",
        }),
      );
      expect(traffic).toContainEqual(
        expect.objectContaining({ event: "websocket-port-traffic-reply", path: "/socket-mode" }),
      );
    } finally {
      await fixture.stop();
    }
  }, 25_000);

  it.each([
    [
      "Discord",
      FAKE_DISCORD_GATEWAY,
      [] as string[],
      (portFile: string, captureFile: string) => ({
        FAKE_DISCORD_GATEWAY_HOST: "127.0.0.1",
        FAKE_DISCORD_GATEWAY_PORT: "0",
        FAKE_DISCORD_GATEWAY_PORT_FILE: portFile,
        FAKE_DISCORD_GATEWAY_CAPTURE_FILE: captureFile,
        FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: "fake-discord-readiness-token",
      }),
    ],
    [
      "Telegram",
      FAKE_TELEGRAM_API,
      [] as string[],
      (portFile: string, captureFile: string) => ({
        FAKE_TELEGRAM_API_HOST: "127.0.0.1",
        FAKE_TELEGRAM_API_PORT: "0",
        FAKE_TELEGRAM_API_PORT_FILE: portFile,
        FAKE_TELEGRAM_API_CAPTURE_FILE: captureFile,
        FAKE_TELEGRAM_API_EXPECTED_TOKEN: "fake-telegram-readiness-token",
      }),
    ],
    [
      "WeChat",
      FAKE_WECHAT_API,
      ["--experimental-strip-types"],
      (portFile: string, captureFile: string) => ({
        FAKE_WECHAT_API_HOST: "127.0.0.1",
        FAKE_WECHAT_API_PORT: "0",
        FAKE_WECHAT_API_PORT_FILE: portFile,
        FAKE_WECHAT_API_CAPTURE_FILE: captureFile,
        FAKE_WECHAT_API_EXPECTED_TOKEN: "fake-wechat-readiness-token",
        FAKE_WECHAT_API_EXPECTED_TARGET: "readiness-user@im.wechat",
        FAKE_WECHAT_API_EXPECTED_TEXT: "readiness proof",
      }),
    ],
  ])(
    "accepts the %s fake API REST traffic reply",
    async (provider, script, nodeArgs, env) => {
      const fixture = await startFakePortFixture({
        label: `fake ${provider} port fixture`,
        script,
        nodeArgs,
        env,
      });

      try {
        const trafficCheck = runPortTrafficCheck(fixture.restPort);
        expect(trafficCheck.status, trafficCheck.stderr).toBe(0);
      } finally {
        await fixture.stop();
      }
    },
    15_000,
  );

  it("rejects an invalid reply through the generic REST-only traffic probe", async () => {
    const fixture = await startFakeSlackPortFixture({
      restPortTrafficReply: "unexpected_reply",
    });

    try {
      const trafficCheck = runPortTrafficCheck(fixture.restPort);
      expect(trafficCheck.status).toBe(1);
      expect(trafficCheck.stderr).toContain("REST port traffic reply was not recognized");
    } finally {
      await fixture.stop();
    }
  }, 15_000);

  it.each([
    ["an HTTP error", 502, "nemoclaw_port_traffic_reply", "HTTP 502"],
    ["an invalid sentinel", 200, "unexpected_reply", "not recognized"],
  ] as const)(
    "rejects %s from the REST port traffic probe",
    async (_case, status, reply, error) => {
      const fixture = await startFakeSlackPortFixture({
        restPortTrafficStatus: status,
        restPortTrafficReply: reply,
      });

      try {
        const trafficCheck = runFakeSlackPortTrafficCheck(fixture);
        expect(trafficCheck.status).toBe(1);
        expect(trafficCheck.stderr).toContain(error);
      } finally {
        await fixture.stop();
      }
    },
    15_000,
  );

  it("rejects a fake Slack websocket that upgrades without a port traffic reply", async () => {
    const fixture = await startFakeSlackPortFixture({ suppressPortTrafficReply: true });

    try {
      const trafficCheck = runFakeSlackPortTrafficCheck(fixture);
      expect(trafficCheck.status).toBe(1);
      expect(trafficCheck.stderr).toContain("WebSocket port traffic timed out");
      const traffic = readFakeSlackCapture(fixture.captureFile);
      expect(traffic).toContainEqual(
        expect.objectContaining({ event: "websocket-upgrade", path: "/socket-mode" }),
      );
      expect(traffic).toContainEqual(
        expect.objectContaining({
          event: "websocket-message",
          messageType: "nemoclaw_port_traffic_probe",
          path: "/socket-mode",
        }),
      );
      expect(traffic).not.toContainEqual(
        expect.objectContaining({ event: "websocket-port-traffic-reply" }),
      );
    } finally {
      await fixture.stop();
    }
  }, 20_000);

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

  it("uses OpenClaw's loaded plugin inventory for the WeChat runtime root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-plugin-root-"));
    const packageRoot = path.join(dir, "packages", "openclaw-weixin");
    fs.mkdirSync(packageRoot, { recursive: true });
    try {
      const inventory = JSON.stringify({
        plugins: [
          {
            id: "openclaw-weixin",
            enabled: true,
            status: "loaded",
            rootDir: packageRoot,
            installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
          },
        ],
      });
      const source = [
        'import fs from "node:fs";',
        'import path from "node:path";',
        WECHAT_INSTALLED_PLUGIN_DISCOVERY_SOURCE,
        `process.stdout.write(resolveInstalledWechatPluginRoot(${JSON.stringify(inventory)}));`,
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        input: source,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(fs.realpathSync(packageRoot));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts Telegram tokens from fake API captures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-telegram-redaction-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const credentialFile = path.join(dir, "expected-token");
    const token = "123456:SUPER-SECRET-TELEGRAM-TOKEN";
    fs.writeFileSync(credentialFile, token, { mode: 0o600 });
    const child = spawn(process.execPath, [FAKE_TELEGRAM_API], {
      env: {
        ...process.env,
        FAKE_TELEGRAM_API_HOST: "127.0.0.1",
        FAKE_TELEGRAM_API_PORT: "0",
        FAKE_TELEGRAM_API_PORT_FILE: portFile,
        FAKE_TELEGRAM_API_CAPTURE_FILE: captureFile,
        FAKE_TELEGRAM_API_EXPECTED_TOKEN_FILE: credentialFile,
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
