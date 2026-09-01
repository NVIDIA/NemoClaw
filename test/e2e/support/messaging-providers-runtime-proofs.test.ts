// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  applyCredentialBoundFakePolicy,
  buildSandboxNodeInvocation,
  buildSandboxShellInvocation,
  countJsonLines,
  type FakeDockerApi,
  isNvidiaEndpointRateLimitFailure,
  messagingEnv,
  OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  parseRuntimeProofPort,
  precleanMessagingResources,
  REPO_ROOT,
  slackCredentialBindingEvidence,
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
const SLACK_POLICY_SANDBOX = "e2e-msg-policy";

type CleanupAction = {
  name: string;
  run: () => Promise<void>;
};

type SyntheticSlackEndpoint = {
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  request_body_credential_rewrite: boolean;
  path?: string;
  credential_binding?: { provider: string };
  rules: Array<{ allow: { method: string; path: string } }>;
};

const PRECLEAN_DENIAL_CASES: Array<[string, string[]]> = [
  ["nemoclaw", ["nemoclaw"]],
  ["openshell-sandbox", ["nemoclaw", "openshell-sandbox"]],
  ["openshell-gateway", ["nemoclaw", "openshell-sandbox", "openshell-gateway"]],
];

const SYNTHETIC_SLACK_ENDPOINTS: readonly SyntheticSlackEndpoint[] = [
  {
    host: "slack.com",
    port: 443,
    protocol: "rest",
    enforcement: "enforce",
    request_body_credential_rewrite: true,
    path: "/api/apps.connections.open",
    credential_binding: { provider: `${SLACK_POLICY_SANDBOX}-slack-app` },
    rules: [{ allow: { method: "POST", path: "/api/apps.connections.open" } }],
  },
  ...["slack.com", "api.slack.com", "hooks.slack.com"].map((host) => ({
    host,
    port: 443,
    protocol: "rest",
    enforcement: "enforce",
    request_body_credential_rewrite: true,
    credential_binding: { provider: `${SLACK_POLICY_SANDBOX}-slack-bridge` },
    rules: [{ allow: { method: "GET", path: "/**" } }, { allow: { method: "POST", path: "/**" } }],
  })),
];

function syntheticSlackPolicy(mutate?: (endpoints: SyntheticSlackEndpoint[]) => void): string {
  const endpoints = structuredClone(SYNTHETIC_SLACK_ENDPOINTS) as SyntheticSlackEndpoint[];
  mutate?.(endpoints);
  return YAML.stringify({
    version: 1,
    network_policies: { slack: { name: "slack", endpoints } },
  });
}

function mutateSlackEndpoint(
  host: string,
  provider: string,
  mutate: (endpoint: SyntheticSlackEndpoint) => void,
): string {
  return syntheticSlackPolicy((endpoints) => {
    const endpoint = endpoints.find(
      (candidate) => candidate.host === host && candidate.credential_binding?.provider === provider,
    );
    expect(endpoint).toBeDefined();
    mutate(endpoint!);
  });
}

const CREDENTIAL_BOUND_SLACK_POLICY = syntheticSlackPolicy();

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

type FakeDockerObservationOverrides = {
  readonly apiPublishedAddress?: string;
  readonly internal?: boolean;
  readonly proxyExtraBridge?: boolean;
  readonly proxyPublishedAddress?: string;
};

function fakeDockerHost(overrides: FakeDockerObservationOverrides = {}): HostCliClient {
  const calls: string[][] = [];
  const host = {
    command: async (command: string, args: string[]) => {
      expect(command).toBe("docker");
      calls.push([...args]);
      args
        .filter((argument) => args[0] === "run" && argument.endsWith(":/tmp/fake"))
        .forEach((fakeApiMount) => {
          const fixtureDir = fakeApiMount.slice(0, -":/tmp/fake".length);
          fs.writeFileSync(path.join(fixtureDir, "port"), "8080");
        });
      const inspectContainer = () => {
        const containerName = args.at(-1);
        const run = calls.find(
          (candidate) =>
            candidate[0] === "run" && candidate[candidate.indexOf("--name") + 1] === containerName,
        );
        expect(run, `Docker run exists for ${String(containerName)}`).toBeDefined();
        const network = run![run!.indexOf("--network") + 1]!;
        const proxy = run!.some((argument) =>
          argument.startsWith("NEMOCLAW_FAKE_API_PROXY_PORTS="),
        );
        const networks: Record<string, unknown> = {
          [network]: {},
          ...(proxy && overrides.proxyExtraBridge ? { bridge: {} } : {}),
        };
        const publications = run!.flatMap((argument, index) =>
          argument === "-p" ? [run![index + 1]!] : [],
        );
        const proxyPorts = Object.fromEntries(
          publications.map((publication, index) => {
            const containerPort = publication.split(":").at(-1)!;
            return [
              `${containerPort}/tcp`,
              [
                {
                  HostIp: overrides.proxyPublishedAddress ?? "127.0.0.1",
                  HostPort: index === 0 ? "32100" : "32101",
                },
              ],
            ];
          }),
        );
        const apiPorts = overrides.apiPublishedAddress
          ? {
              "8080/tcp": [{ HostIp: overrides.apiPublishedAddress, HostPort: "32099" }],
            }
          : {};
        const ports = proxy ? proxyPorts : apiPorts;
        return successfulCommand(`${JSON.stringify({ Networks: networks, Ports: ports })}\n`);
      };
      const responses: Record<string, () => ReturnType<typeof successfulCommand>> = {
        "container:inspect": inspectContainer,
        "network:inspect": () =>
          successfulCommand(`${JSON.stringify(overrides.internal ?? true)}\n`),
      };
      return (responses[`${String(args[0])}:${String(args[1])}`] ?? successfulCommand)();
    },
  } as unknown as HostCliClient;
  return host;
}

async function runCleanup(actions: CleanupAction[]): Promise<void> {
  for (let index = actions.length - 1; index >= 0; index -= 1) await actions[index]!.run();
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
        "host.docker.internal:43117:GET:/**",
        "host.docker.internal:43117:WEBSOCKET_TEXT:/**",
      ],
      policyHost: "host.docker.internal",
      binaries: [
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
        "/opt/hermes/.venv/bin/python",
      ],
    },
  ])(
    "when a $protocol fake endpoint is bound, one policy owner retains rewrite, binary, and wait arguments",
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
        binaries: binaries.slice(2),
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
      expect(binding.command).toBe("bash");
      expect(binding.args).toContain("/trusted/openshell");
      expect(binding.args).toContain("e2e-messaging-policy-bridge");
      expect(binding.args).toContain(expectedHost);
      expect(binding.args).toContain(protocol);
      expect(binding.args).toContain(
        path.join(REPO_ROOT, "test/e2e/fixtures/credential-policy-binding.ts"),
      );
      expect(binding.args[1]).toContain('policy get --base "$2"');
      expect(binding.args[1]).toContain('policy set --policy "$policy_file" --wait "$2"');
    },
  );

  it("accepts Slack bot and app credential bindings and rejects policies without them", () => {
    const legacyPolicy = `
network_policies:
  slack:
    name: slack
    endpoints:
      - host: slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: POST, path: "/**" }
`;

    expect(
      slackCredentialBindingEvidence(CREDENTIAL_BOUND_SLACK_POLICY, SLACK_POLICY_SANDBOX),
    ).toEqual({
      app: true,
      bot: true,
    });
    expect(slackCredentialBindingEvidence(legacyPolicy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });

  it.each([
    [
      "port",
      (endpoint: SyntheticSlackEndpoint) => {
        endpoint.port = 80;
      },
    ],
    [
      "protocol",
      (endpoint: SyntheticSlackEndpoint) => {
        endpoint.protocol = "websocket";
      },
    ],
    [
      "enforcement",
      (endpoint: SyntheticSlackEndpoint) => {
        endpoint.enforcement = "audit";
      },
    ],
    [
      "app rule",
      (endpoint: SyntheticSlackEndpoint) => {
        endpoint.rules = [{ allow: { method: "GET", path: "/api/apps.connections.open" } }];
      },
    ],
  ])("rejects an app credential endpoint with the wrong %s", (_field, mutate) => {
    const policy = mutateSlackEndpoint("slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, mutate);

    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: true,
    });
  });

  it("rejects a bot credential endpoint without both broad Slack API rules", () => {
    const policy = mutateSlackEndpoint(
      "slack.com",
      `${SLACK_POLICY_SANDBOX}-slack-bridge`,
      (endpoint) => {
        endpoint.rules = endpoint.rules.filter((rule) => rule.allow.method !== "GET");
      },
    );

    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: true,
      bot: false,
    });
  });

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint when its credential provider is wrong",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        endpoint.credential_binding = { provider: "wrong-provider" };
      });

      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint when its credential provider is absent",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        delete endpoint.credential_binding;
      });

      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint with an extra credential-bearing permission",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        endpoint.rules.push({ allow: { method: "DELETE", path: "/**" } });
      });

      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each(["api.slack.com", "hooks.slack.com"])(
    "rejects the %s bot route without credential rewrite",
    (host) => {
      const policy = mutateSlackEndpoint(
        host,
        `${SLACK_POLICY_SANDBOX}-slack-bridge`,
        (endpoint) => {
          endpoint.request_body_credential_rewrite = false;
        },
      );

      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: true,
        bot: false,
      });
    },
  );

  it("rejects an extra unbound broad Slack REST endpoint", () => {
    const policy = syntheticSlackPolicy((endpoints) => {
      endpoints.push({
        host: "slack.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: false,
        rules: [
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "POST", path: "/**" } },
        ],
      });
    });

    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });

  it("treats a malformed Slack endpoint as missing credential evidence", () => {
    const policy = `
network_policies:
  slack:
    endpoints:
      - null
`;

    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });

  it.each(["discord-gateway", "slack"] as const)(
    "accepts observed internal-network and loopback-only evidence for the fake %s API",
    async (kind) => {
      const host = fakeDockerHost();
      const cleanup: CleanupAction[] = [];

      try {
        const api = await startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
          kind,
          imageScript: `fake-${kind}-api.cjs`,
          containerPrefix: `fake-${kind}`,
          portEnv: "FAKE_API_PORT",
          portFileEnv: "FAKE_API_PORT_FILE",
          captureFileEnv: "FAKE_API_CAPTURE_FILE",
          expectedEnv: {},
          redactionValues: [],
          env: {},
        });
        expect(api.port).toBe("32100");
        expect(api.alternatePort).toBe(kind === "slack" ? "32101" : undefined);
      } finally {
        await runCleanup(cleanup);
      }
    },
  );

  it("rejects a fake API proxy port that Docker publishes beyond loopback", async () => {
    const host = fakeDockerHost({ proxyPublishedAddress: "0.0.0.0" });
    const cleanup: CleanupAction[] = [];

    try {
      await expect(
        startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
          kind: "discord-gateway",
          imageScript: "fake-discord-gateway-api.cjs",
          containerPrefix: "fake-discord-gateway",
          portEnv: "FAKE_API_PORT",
          portFileEnv: "FAKE_API_PORT_FILE",
          captureFileEnv: "FAKE_API_CAPTURE_FILE",
          expectedEnv: {},
          redactionValues: [],
          env: {},
        }),
      ).rejects.toThrow(/did not bind only to 127\.0\.0\.1/u);
    } finally {
      await runCleanup(cleanup);
    }
  });

  it.each([
    [
      "a non-internal network",
      { internal: false },
      /fake discord-gateway API network is not internal/u,
    ],
    [
      "a fake API host publication",
      { apiPublishedAddress: "127.0.0.1" },
      /API container unexpectedly published a host port/u,
    ],
    [
      "an extra proxy bridge attachment",
      { proxyExtraBridge: true },
      /API proxy did not use only its internal Docker network/u,
    ],
  ] as const)(
    "rejects observed Docker isolation evidence with %s",
    async (_label, overrides, error) => {
      const host = fakeDockerHost(overrides);
      const cleanup: CleanupAction[] = [];

      try {
        await expect(
          startFakeDockerApi(host, (name, run) => cleanup.push({ name, run }), {
            kind: "discord-gateway",
            imageScript: "fake-discord-gateway-api.cjs",
            containerPrefix: "fake-discord-gateway",
            portEnv: "FAKE_API_PORT",
            portFileEnv: "FAKE_API_PORT_FILE",
            captureFileEnv: "FAKE_API_CAPTURE_FILE",
            expectedEnv: {},
            redactionValues: [],
            env: {},
          }),
        ).rejects.toThrow(error);
      } finally {
        await runCleanup(cleanup);
      }
    },
  );

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
  });

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
