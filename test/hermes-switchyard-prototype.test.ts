// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInactiveHomebrewGatewayService,
  assertNoManagedBridgeProxyContainers,
  assertNoManagedPortDockerResources,
  assertNoRegisteredGateways,
  buildManagedBridgeProxyArgs,
  buildManagedCleanupEnvironment,
  buildManagedCommandEnvironment,
  buildManagedDockerEnvironment,
  buildManagedOnboardArgs,
  buildManagedOnboardEnvironment,
  buildManagedTurnExecArgs,
  isOwnedManagedOnboardSession,
  isOwnedManagedTempRoot,
  validateManagedBridgeGateway,
  validateManagedDockerHost,
  validateManagedStatus,
} from "../scripts/hermes-switchyard-prototype/managed.mts";
import {
  buildRuntimeDockerArgs,
  copyRelaySourceForBuild,
  HERMES_SWITCHYARD_PROTOTYPE,
  isOwnedPrototypeTempRoot,
  parsePrototypeResult,
  RELAY_FETCH_TIMEOUT_MS,
  RELAY_VALIDATION_TIMEOUT_MS,
  relaySourceCachePath,
  runSupervisedCommandForTest,
  validateRelayIdentity,
  validateTrackedPrototypeAssets,
} from "../scripts/hermes-switchyard-prototype/run.mts";

const createdTempRoots: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const root of createdTempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForLoopbackPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fake provider did not become ready");
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function validIdentity() {
  const packages = ["switchyard-libsy", "switchyard-protocol", "switchyard-translation"];
  const switchyardSource = "https://switchyard.invalid/Switchyard.git";
  return {
    head: HERMES_SWITCHYARD_PROTOTYPE.relayRevision,
    cargoToml: `[workspace.dependencies]\n${packages
      .map(
        (name) =>
          `${name} = { git = "${switchyardSource}", rev = "${HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision}" }`,
      )
      .join("\n")}`,
    cargoLock: packages
      .map(
        (name) =>
          `[[package]]\nname = "${name}"\nsource = "git+${switchyardSource}?rev=${HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision}#${HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision}"`,
      )
      .join("\n"),
  };
}

function runEvidenceVerifier(
  root: string,
  atofEvents: object[],
  runtime: "standalone" | "nemoclaw-managed" = "standalone",
): ReturnType<typeof spawnSync> {
  const providerLog = path.join(root, "provider.jsonl");
  const atofLog = path.join(root, "trajectory.atof.jsonl");
  const relayLog = path.join(root, "relay.log");
  const relayBinary = path.join(root, "nemo-relay");
  const verifier = path.join(process.cwd(), "scripts", "hermes-switchyard-prototype", "verify.py");
  const providerEvents = [
    {
      classifier_reason: "bounded summary is suitable for the efficient tier",
      classifier_tier: "weak",
      demo_turn: "bounded-summary",
      model: "provider/classifier",
      response_format_type: "json_schema",
    },
    {
      demo_answer: "Two medium findings remain; schedule normal remediation.",
      demo_turn: "bounded-summary",
      model: "provider/fast",
      selected_tier: "weak",
    },
    {
      classifier_reason: "higher-risk multi-service plan requires the capable tier",
      classifier_tier: "strong",
      demo_turn: "risk-remediation",
      model: "provider/classifier",
      response_format_type: "json_schema",
    },
    {
      demo_answer:
        "Contain affected services, isolate credentials, patch critical findings, preserve rollback, and verify the clean state end to end.",
      demo_turn: "risk-remediation",
      model: "provider/quality",
      selected_tier: "strong",
    },
  ].map((event) => ({
    accepted: true,
    authorization_matches: true,
    client_executable: "nemo-relay",
    path: "/v1/chat/completions",
    stream: true,
    switchyard_server_seen: false,
    unexpected_credential_seen: false,
    ...event,
  }));
  fs.writeFileSync(providerLog, providerEvents.map((event) => JSON.stringify(event)).join("\n"));
  fs.writeFileSync(atofLog, atofEvents.map((event) => JSON.stringify(event)).join("\n"));
  fs.writeFileSync(relayLog, "sanitized relay output\n");
  fs.writeFileSync(relayBinary, "prototype binary");
  const python = [
    "import argparse, importlib.util, os",
    `spec = importlib.util.spec_from_file_location("prototype_verify", ${JSON.stringify(verifier)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.process_names = lambda: set()",
    `module.socket.if_nameindex = lambda: ${runtime === "standalone" ? '[(1, "lo")]' : '[(1, "lo"), (2, "eth0")]'}`,
    'os.environ["PROTOTYPE_HERMES_VERSION"] = "Hermes Agent v0.19.0"',
    'os.environ["PROTOTYPE_RELAY_VERSION"] = "nemo-relay 0.6.0"',
    "module.verify(argparse.Namespace(",
    `    atof_log=module.Path(${JSON.stringify(atofLog)}),`,
    `    provider_log=module.Path(${JSON.stringify(providerLog)}),`,
    `    relay_binary=module.Path(${JSON.stringify(relayBinary)}),`,
    `    relay_log=module.Path(${JSON.stringify(relayLog)}),`,
    `    runtime=${JSON.stringify(runtime)},`,
    "))",
  ].join("\n");
  return spawnSync("python3", ["-c", python], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
}

describe("experimental Hermes Relay Switchyard prototype", () => {
  it("binds Relay and all Switchyard crates to the audited source revisions (#7937)", () => {
    expect(() => validateRelayIdentity(validIdentity())).not.toThrow();
    expect(() =>
      validateRelayIdentity({
        ...validIdentity(),
        head: "0".repeat(40),
      }),
    ).toThrow(/Relay identity mismatch/);
    expect(() =>
      validateRelayIdentity({
        ...validIdentity(),
        cargoToml: validIdentity().cargoToml.replace(
          HERMES_SWITCHYARD_PROTOTYPE.switchyardRevision,
          "1".repeat(40),
        ),
      }),
    ).toThrow(/manifest pin/);
    const missingPackageSource = validIdentity();
    missingPackageSource.cargoLock = missingPackageSource.cargoLock.replace(
      new RegExp(`(name = "switchyard-libsy"\\n)source = "[^"]+"`),
      "$1",
    );
    expect(() => validateRelayIdentity(missingPackageSource)).toThrow(/lockfile pin/);
  });

  it("runs the Hermes turn offline with a read-only least-privilege container (#7937)", () => {
    const args = buildRuntimeDockerArgs("prototype:test", "prototype-test");
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "sandbox:sandbox",
      ]),
    );
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--mount");
    expect(args.filter((value) => value === "--network")).toHaveLength(1);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args.filter((value) => value === "--read-only")).toHaveLength(1);
    expect(args.filter((value) => value === "--env")).toHaveLength(6);
  });

  it("uses the public NemoClaw lifecycle for the managed execution path (#7937)", () => {
    const sandboxName = "hermes-switchyard-proto-test";
    const onboard = buildManagedOnboardArgs(sandboxName);
    expect(onboard).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/bin/nemohermes.js"),
        "onboard",
        "--non-interactive",
        "--name",
        sandboxName,
        "--agent",
        "hermes",
        "--no-gpu",
        "--no-sandbox-gpu",
      ]),
    );
    expect(onboard).not.toContain("--fresh");
    expect(onboard).not.toContain("--from");

    const hash = "a".repeat(64);
    const remoteRoot = `/sandbox/.nemoclaw-prototypes/${sandboxName}`;
    const turn = buildManagedTurnExecArgs(sandboxName, remoteRoot, hash);
    expect(turn).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        sandboxName,
        "PROTOTYPE_RUNTIME=nemoclaw-managed",
        `PROTOTYPE_EXPECTED_RELAY_SHA256=${hash}`,
        "bash",
        "./run.sh",
      ]),
    );
    expect(turn).not.toContain("docker");
    expect(() => buildManagedTurnExecArgs(sandboxName, "/tmp/escaped", hash)).toThrow(/escaped/);
  });

  it("isolates managed onboarding from ambient credentials and shared gateways (#7937)", () => {
    const env = buildManagedOnboardEnvironment({
      apiKey: "disposable",
      dockerHost: "unix:///tmp/docker.sock",
      endpointUrl: "http://host.openshell.internal:32123/v1",
      gatewayName: "nemoclaw-32124",
      gatewayPort: 32124,
      sandboxName: "hermes-switchyard-proto-test",
      source: {
        DOCKER_CONTEXT: "foreign",
        DOCKER_HOST: "unix:///tmp/wrong.sock",
        HOME: "/tmp/example",
        NEMOCLAW_COMPATIBLE_AUTH_MODE: "none",
        NVIDIA_INFERENCE_API_KEY: "real-key",
        OPENAI_API_KEY: "real-openai-key",
        PATH: "/usr/bin",
      },
    });
    expect(env).toMatchObject({
      COMPATIBLE_API_KEY: "disposable",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      HOME: "/tmp/example",
      NEMOCLAW_ENDPOINT_URL: "http://host.openshell.internal:32123/v1",
      NEMOCLAW_GATEWAY_PORT: "32124",
      NEMOCLAW_HEALTH_POLL_COUNT: "90",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_REASONING: "true",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
      OPENSHELL_GATEWAY: "nemoclaw-32124",
      PATH: "/usr/bin",
    });
    expect(env.NEMOCLAW_COMPATIBLE_AUTH_MODE).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(() => assertNoRegisteredGateways("[]")).not.toThrow();
    expect(() => assertNoRegisteredGateways('[{"name":"shared"}]')).toThrow(/shared/);
    expect(
      buildManagedDockerEnvironment("unix:///tmp/docker.sock", {
        DOCKER_CONTEXT: "foreign",
        DOCKER_HOST: "unix:///tmp/wrong.sock",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      DOCKER_HOST: "unix:///tmp/docker.sock",
      PATH: "/usr/bin",
    });
    expect(
      buildManagedCommandEnvironment({
        dockerHost: "unix:///tmp/docker.sock",
        gatewayName: "nemoclaw-32124",
        gatewayPort: 32124,
        source: {
          DOCKER_CONTEXT: "foreign",
          DOCKER_HOST: "unix:///tmp/wrong.sock",
          NEMOCLAW_GATEWAY_PORT: "8080",
          OPENSHELL_GATEWAY: "shared",
          PATH: "/usr/bin",
        },
      }),
    ).toEqual({
      DOCKER_HOST: "unix:///tmp/docker.sock",
      NEMOCLAW_GATEWAY_PORT: "32124",
      OPENSHELL_GATEWAY: "nemoclaw-32124",
      PATH: "/usr/bin",
    });
    expect(
      buildManagedCleanupEnvironment({
        DOCKER_HOST: "unix:///tmp/docker.sock",
        NEMOCLAW_GATEWAY_PORT: "32124",
        OPENSHELL_GATEWAY: "nemoclaw-32124",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      DOCKER_HOST: "unix:///tmp/docker.sock",
      NEMOCLAW_CLEANUP_GATEWAY: "1",
      NEMOCLAW_GATEWAY_PORT: "32124",
      OPENSHELL_GATEWAY: "nemoclaw-32124",
      PATH: "/usr/bin",
    });
    expect(() =>
      assertNoManagedPortDockerResources(
        32124,
        "nemoclaw-openshell-gateway-321240\n",
        "openshell-cluster-nemoclaw-321240-cache\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoManagedPortDockerResources(32124, "nemoclaw-openshell-gateway-32124\n", ""),
    ).toThrow(/32124/);
    expect(() =>
      assertNoManagedPortDockerResources(32124, "", "openshell-cluster-nemoclaw-32124-cache\n"),
    ).toThrow(/32124/);
    const inactiveService = {
      loaded: false,
      name: "openshell",
      registered: false,
      running: false,
      service_name: "homebrew.mxcl.openshell",
    };
    expect(() =>
      assertInactiveHomebrewGatewayService(JSON.stringify([inactiveService])),
    ).not.toThrow();
    expect(() =>
      assertInactiveHomebrewGatewayService(
        JSON.stringify([{ ...inactiveService, loaded: true, running: true }]),
      ),
    ).toThrow(/inactive/);
    expect(validateManagedBridgeGateway('"172.17.0.1"')).toBe("172.17.0.1");
    expect(() => validateManagedBridgeGateway('"127.0.0.1"')).toThrow(/non-loopback/);
    expect(() => assertNoManagedBridgeProxyContainers("")).not.toThrow();
    expect(() => assertNoManagedBridgeProxyContainers("residual-proxy\n")).toThrow(/residual/);
    const proxyArgs = buildManagedBridgeProxyArgs({
      bridgeGateway: "172.17.0.1",
      containerName: "nemoclaw-hs-bridge-test",
      gatewayPort: 32124,
      providerPort: 32123,
      sandboxName: "hermes-switchyard-proto-test",
    });
    expect(proxyArgs).toEqual(
      expect.arrayContaining([
        "--network",
        "host",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65534:65534",
        "32124",
        "32123",
      ]),
    );
    expect(proxyArgs).not.toContain("--privileged");
    expect(proxyArgs).not.toContain("--volume");
    expect(proxyArgs).not.toContain("-v");
    expect(proxyArgs).not.toContain("--env");

    expect(() => validateManagedDockerHost('"tcp://127.0.0.1:2375"')).toThrow(/unix/);

    const startedAt = Date.now();
    expect(
      isOwnedManagedOnboardSession(
        JSON.stringify({
          agent: "hermes",
          sandboxName: null,
          startedAt: new Date(startedAt).toISOString(),
          status: "failed",
        }),
        "hermes-switchyard-proto-test",
        startedAt,
      ),
    ).toBe(true);
    expect(
      isOwnedManagedOnboardSession(
        JSON.stringify({
          agent: "hermes",
          checkpoint: {
            gatewayAuthority: {
              kind: "selected",
              value: {
                gatewayName: "nemoclaw-32124",
                gatewayPort: 32124,
              },
            },
          },
          sandboxName: null,
          startedAt: new Date(startedAt).toISOString(),
          status: "complete",
        }),
        "hermes-switchyard-proto-test",
        startedAt,
        "nemoclaw-32124",
        32124,
      ),
    ).toBe(true);
    expect(
      isOwnedManagedOnboardSession(
        JSON.stringify({
          agent: "openclaw",
          sandboxName: null,
          startedAt: new Date(startedAt).toISOString(),
          status: "failed",
        }),
        "hermes-switchyard-proto-test",
        startedAt,
      ),
    ).toBe(false);
  });

  it("requires healthy inference.local before accepting managed status (#7937)", () => {
    const status = {
      failureLayer: null,
      found: true,
      gatewayState: "present",
      inferenceHealth: {
        endpoint: "https://inference.local/v1/models",
        ok: true,
        probed: true,
      },
      name: "hermes-switchyard-proto-test",
      phase: "Ready",
      rpcIssue: null,
      terminalRuntimeHealth: { kind: "healthy" },
    };
    expect(validateManagedStatus(JSON.stringify(status), "hermes-switchyard-proto-test")).toEqual({
      inferenceEndpoint: "https://inference.local/v1/models",
      phase: "Ready",
    });
    expect(() =>
      validateManagedStatus(
        JSON.stringify({
          ...status,
          inferenceHealth: { ...status.inferenceHealth, ok: false },
        }),
        "hermes-switchyard-proto-test",
      ),
    ).toThrow(/not healthy/);
  });

  it("rejects leaked credentials and ambiguous runtime evidence (#7937)", () => {
    const good = `log line\nNEMOCLAW_HERMES_SWITCHYARD_PROTOTYPE={"status":"pass"}`;
    expect(parsePrototypeResult(good, "")).toEqual({ status: "pass" });
    expect(() =>
      parsePrototypeResult(`${good}\n${HERMES_SWITCHYARD_PROTOTYPE.clientApiKey}`, ""),
    ).toThrow(/credential sentinel/);
    expect(() => parsePrototypeResult(`${good}\n${good}`, "")).toThrow(/Expected one/);
  });

  it("accepts only the exact streamed Switchyard routing lifecycle (#7937)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-verifier-contract-"));
    createdTempRoots.push(root);
    const routingEvents = [
      { data: {}, name: "switchyard.routing.requested" },
      { data: { is_routed_call: false }, name: "switchyard.routing.call" },
      { data: { is_routed_call: true }, name: "switchyard.routing.call" },
      {
        data: { is_routed_call: true, semantic_target: "fast" },
        name: "switchyard.routing.decision",
      },
      {
        attributes: ["streaming"],
        category_profile: { annotated_response: { model: "provider/fast" } },
        kind: "scope",
        scope_category: "end",
      },
      { data: {}, name: "switchyard.routing.requested" },
      { data: { is_routed_call: false }, name: "switchyard.routing.call" },
      { data: { is_routed_call: true }, name: "switchyard.routing.call" },
      {
        data: { is_routed_call: true, semantic_target: "quality" },
        name: "switchyard.routing.decision",
      },
      {
        attributes: ["streaming"],
        category_profile: { annotated_response: { model: "provider/quality" } },
        kind: "scope",
        scope_category: "end",
      },
    ];

    const valid = runEvidenceVerifier(root, routingEvents);
    expect(valid.status, String(valid.stderr)).toBe(0);
    expect(valid.stdout).toContain('"network":"none"');
    expect(valid.stdout).toContain('"provider_streaming":[true,true,true,true]');
    expect(valid.stdout).toContain('"prompt":"Summarize this bounded status in one sentence:');
    expect(valid.stdout).toContain(
      '"prompt":"Design a fail-closed remediation plan for critical vulnerabilities',
    );
    expect(valid.stdout).toContain('"tier":"weak"');
    expect(valid.stdout).toContain('"tier":"strong"');
    expect(valid.stdout).toContain('"runtime":"standalone"');

    const managed = runEvidenceVerifier(root, routingEvents, "nemoclaw-managed");
    expect(managed.status, String(managed.stderr)).toBe(0);
    expect(managed.stdout).toContain('"network":"openshell-managed"');
    expect(managed.stdout).toContain('"runtime":"nemoclaw-managed"');

    const duplicateDecision = runEvidenceVerifier(root, [...routingEvents, routingEvents[3]]);
    expect(duplicateDecision.status).toBe(1);
    expect(duplicateDecision.stderr).toContain("unexpected Switchyard routing lifecycle");
  });

  it("rejects invalid provider paths, credentials, and leaked sentinels (#7937)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-contract-"));
    createdTempRoots.push(root);
    const log = path.join(root, "provider.jsonl");
    const port = await reserveLoopbackPort();
    const provider = spawn(
      "python3",
      [
        path.join(process.cwd(), "scripts", "hermes-switchyard-prototype", "fake-provider.py"),
        "--port",
        String(port),
        "--log",
        log,
      ],
      {
        env: {
          ...process.env,
          PROTOTYPE_PROVIDER_AUTHORIZATION: HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: "ignore",
      },
    );
    childProcesses.push(provider);
    await waitForLoopbackPort(port);

    const post = (pathname: string, authorization: string, body: object) =>
      fetch(`http://127.0.0.1:${port}${pathname}`, {
        body: JSON.stringify(body),
        headers: { authorization, "content-type": "application/json" },
        method: "POST",
      });
    expect(
      (
        await post("/wrong", HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization, {
          model: "provider/fast",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post("/v1/chat/completions", "Bearer wrong", {
          model: "provider/fast",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/v1/chat/completions", HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization, {
          messages: [{ content: HERMES_SWITCHYARD_PROTOTYPE.clientApiKey }],
          model: "provider/fast",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/v1/chat/completions", HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization, {
          model: "provider/fast",
          stream: false,
        })
      ).status,
    ).toBe(200);

    const bounded = await post(
      "/v1/chat/completions",
      HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
      {
        messages: [
          {
            content:
              "Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 medium findings.",
            role: "user",
          },
        ],
        model: "provider/classifier",
      },
    );
    const boundedBody = (await bounded.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(JSON.parse(boundedBody.choices[0].message.content)).toMatchObject({
      p_solve: 0.9,
      recommended_route: "efficient",
    });

    const capable = await post(
      "/v1/chat/completions",
      HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization,
      {
        messages: [
          {
            content:
              "Design a fail-closed remediation plan for critical vulnerabilities across multiple services, including credential isolation, rollback, and end-to-end validation.",
            role: "user",
          },
        ],
        model: "provider/classifier",
      },
    );
    const capableBody = (await capable.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(JSON.parse(capableBody.choices[0].message.content)).toMatchObject({
      p_solve: 0.2,
      recommended_route: "capable",
    });

    const raw = fs.readFileSync(log, "utf8");
    const attempts = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(attempts.map((attempt) => attempt.accepted)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(attempts[2].unexpected_credential_seen).toBe(true);
    expect(attempts.slice(-2).map((attempt) => attempt.classifier_tier)).toEqual([
      "weak",
      "strong",
    ]);
    expect(raw).not.toContain(HERMES_SWITCHYARD_PROTOTYPE.clientApiKey);
    expect(raw).not.toContain(HERMES_SWITCHYARD_PROTOTYPE.providerAuthorization);
  });

  it("rejects unauthenticated managed-provider bodies before logging them (#7937)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-provider-contract-"));
    createdTempRoots.push(root);
    const readyFile = path.join(root, "ready");
    const requestLog = path.join(root, "requests.jsonl");
    const apiKey = "managed-provider-test-key";
    const provider = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.join(
          process.cwd(),
          "scripts",
          "hermes-switchyard-prototype",
          "managed-inference-provider.mts",
        ),
      ],
      {
        env: {
          NEMOCLAW_MANAGED_PROTOTYPE_API_KEY: apiKey,
          NEMOCLAW_MANAGED_PROTOTYPE_BIND_HOST: "127.0.0.1",
          NEMOCLAW_MANAGED_PROTOTYPE_BIND_PORT: "0",
          NEMOCLAW_MANAGED_PROTOTYPE_READY_FILE: readyFile,
          NEMOCLAW_MANAGED_PROTOTYPE_REQUEST_LOG: requestLog,
        },
        stdio: "ignore",
      },
    );
    childProcesses.push(provider);
    await waitForFile(readyFile);
    const port = Number(fs.readFileSync(readyFile, "utf8"));

    const untrustedModel = `untrusted-${"x".repeat(512 * 1024)}`;
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      body: JSON.stringify({ model: untrustedModel }),
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(authorized.status).toBe(200);

    const raw = fs.readFileSync(requestLog, "utf8");
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual({
      auth_matches: false,
      method: "POST",
      rejected: "unauthorized",
    });
    expect(records[1]).toMatchObject({ auth_matches: true, method: "GET" });
    expect(Buffer.byteLength(raw)).toBeLessThan(64 * 1024);
    expect(raw).not.toContain("untrusted-");
    expect(raw).not.toContain(apiKey);
  });

  it("only recognizes private temporary roots created for this prototype (#7937)", () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-switchyard-prototype-"));
    createdTempRoots.push(owned);
    expect(isOwnedPrototypeTempRoot(owned)).toBe(true);
    expect(isOwnedPrototypeTempRoot(os.tmpdir())).toBe(false);
    expect(isOwnedPrototypeTempRoot(process.cwd())).toBe(false);

    const managed = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-switchyard-managed-"));
    createdTempRoots.push(managed);
    expect(isOwnedManagedTempRoot(managed)).toBe(true);
    expect(isOwnedManagedTempRoot(os.tmpdir())).toBe(false);
  });

  it("keeps the pinned Relay source cache private and allows a bounded slow first fetch (#7937)", () => {
    const cache = relaySourceCachePath();
    expect(path.dirname(path.dirname(cache))).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(cache)).toBe(HERMES_SWITCHYARD_PROTOTYPE.relayRevision);
    expect(RELAY_FETCH_TIMEOUT_MS).toBe(10 * 60 * 1_000);
    expect(RELAY_VALIDATION_TIMEOUT_MS).toBe(2 * 60 * 1_000);
  });

  it("preserves Relay's relative symlinks when staging the cached source (#7937)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-relay-cache-copy-"));
    createdTempRoots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "AGENTS.md"), "prototype");
    fs.symlinkSync("AGENTS.md", path.join(source, "CLAUDE.md"));

    copyRelaySourceForBuild(source, destination);

    expect(fs.readlinkSync(path.join(destination, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  it("terminates the supervised process group when a command times out (#7937)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-supervision-contract-"));
    createdTempRoots.push(root);
    const childPidPath = path.join(root, "child.pid");
    const script = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await expect(
      runSupervisedCommandForTest(process.execPath, ["-e", script], 1_000),
    ).rejects.toThrow(/timed out/);
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    let childAlive = true;
    for (let attempt = 0; attempt < 50 && childAlive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        childAlive = false;
      }
    }
    expect(childAlive).toBe(false);
  });

  it("keeps exact build pins and credentials outside tracked configuration (#7937)", () => {
    expect(validateTrackedPrototypeAssets()).toEqual({
      router: "llm_classifier",
      targetCount: 3,
    });
  });
});
