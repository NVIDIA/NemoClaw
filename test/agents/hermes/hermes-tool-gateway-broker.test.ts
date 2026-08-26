// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { vi } from "vitest";
import {
  handleHermesBrokerCoexistencePortal,
  handleHermesBrokerUpstream,
  HERMES_BROKER_REDIRECT_BODY,
  HERMES_BROKER_REDIRECT_HEADER,
  HERMES_BROKER_REDIRECT_TARGET,
  type HermesBrokerUpstreamRequest,
} from "../../helpers/hermes-tool-gateway-broker-fixture";
import {
  describe,
  expect,
  type OwnedTestResources,
  test as it,
} from "../../helpers/owned-test-resources";
import { testTimeout } from "../../helpers/timeouts";

const SCRIPT = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "host",
  "tool-gateway-broker.ts",
);
const require = createRequire(import.meta.url);
const BROKER_WRAPPER = path.join(
  import.meta.dirname,
  "../../..",
  "src",
  "lib",
  "hermes-tool-gateway-broker.ts",
);
const CONTROL_CONTRACT = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "host",
  "tool-gateway-control-contract.ts",
);

const BROKER_READINESS_TIMEOUT_MS = 15_000;
const BROKER_TEST_TIMEOUT_MS = testTimeout(45_000);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function startForeignHealthListener(
  resources: OwnedTestResources,
  port: number,
): Promise<ChildProcess> {
  const source = [
    'const http = require("node:http");',
    "const port = Number(process.argv[1]);",
    "const listener = http.createServer((_request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json" });',
    '  response.end("{\\\"ok\\\":true}");',
    "});",
    'listener.once("error", (error) => {',
    "  process.stderr.write(`port ${port} ${error.code || error.message}\\n`);",
    "  process.exit(1);",
    "});",
    'listener.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));',
    'process.once("SIGTERM", () => listener.close(() => process.exit(0)));',
  ].join("\n");
  return startInlineListener(
    resources,
    "foreign health listener",
    source,
    [String(port)],
  );
}

async function startBrokerLikeListener(
  resources: OwnedTestResources,
  port: number,
  controlSocket: string,
): Promise<ChildProcess> {
  const source = [
    'const http = require("node:http");',
    "const [, portValue, controlSocket] = process.argv.slice(1);",
    "const listener = http.createServer((_request, response) => {",
    '  response.writeHead(200, { "content-type": "application/json" });',
    '  response.end("{\\\"ok\\\":true}");',
    "});",
    "const control = http.createServer((_request, response) => {",
    "  response.writeHead(200);",
    '  response.end("{}");',
    "});",
    'listener.once("error", (error) => {',
    "  process.stderr.write(`${error.code || error.message}\\n`);",
    "  process.exit(1);",
    "});",
    'listener.listen(Number(portValue), "127.0.0.1", () => {',
    '  control.listen(controlSocket, () => process.stdout.write("ready\\n"));',
    "});",
    'process.once("SIGTERM", () => {',
    "  listener.close(() => control.close(() => process.exit(0)));",
    "});",
  ].join("\n");
  return startInlineListener(resources, "broker-like listener", source, [
    "tool-gateway-broker.ts",
    String(port),
    controlSocket,
  ]);
}

async function startInlineListener(
  resources: OwnedTestResources,
  description: string,
  source: string,
  args: readonly string[],
): Promise<ChildProcess> {
  const child = resources.ownChild(
    spawn(process.execPath, ["--input-type=commonjs", "--eval", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitForBrokerCondition(
    description,
    child,
    () => output,
    () => output.includes("ready"),
  );
  return child;
}

function brokerDiagnostics(child: ChildProcess, output: () => string): string {
  const captured = output().trim() || "<no broker output>";
  return [
    `exit=${child.exitCode ?? "pending"}, signal=${child.signalCode ?? "none"}`,
    `captured output:\n${captured}`,
  ].join("; ");
}

function controlRequest(
  socketPath: string,
  route:
    | "/credentials/activate"
    | "/credentials/discard"
    | "/credentials/register"
    | "/credentials/stage"
    | "/credentials/status"
    | "/credentials/unregister",
  payload: Record<string, unknown>,
): Promise<{ readonly body: string; readonly status: number }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: route,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function waitForBrokerCondition(
  description: string,
  child: ChildProcess,
  output: () => string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + BROKER_READINESS_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${description}: broker exited early; ${brokerDiagnostics(child, output)}`);
    }
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const lastErrorDetail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `${description}: condition was not met within ${BROKER_READINESS_TIMEOUT_MS}ms; ` +
      `${brokerDiagnostics(child, output)}${lastErrorDetail}`,
  );
}

describe("Hermes managed-tool gateway broker", () => {
  it("keeps the local client deadline beyond the broker's end-to-end deadline", () => {
    const contract = require(CONTROL_CONTRACT);
    expect(contract.HERMES_CLONE_CONTROL_CLIENT_TIMEOUT_MS).toBe(
      contract.HERMES_CLONE_CONTROL_DEADLINE_MS + contract.HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS,
    );
    expect(contract.HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS).toBeGreaterThan(0);
  });

  it("only auto-recovers for Hermes sandboxes with selected managed tools", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);

    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "openclaw",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(false);
    expect(
      broker.ensureHermesToolGatewayBrokerForSandboxEntry({
        agent: "openclaw",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(false);
    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "hermes",
        hermesToolGateways: [],
      }),
    ).toBe(false);
    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "hermes",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(true);
    expect(
      broker.matchesHermesToolGatewayProviderState(
        {
          name: "clone",
          agent: "hermes",
          hermesToolGateways: ["nous-web"],
          hermesInferenceProvider: "clone-hermes-inference",
        },
        {
          sandbox: "clone",
          provider_name: "clone-hermes-tool-gateway",
          inference_provider_name: "clone-hermes-inference",
        },
      ),
    ).toBe(true);
    expect(
      broker.matchesHermesToolGatewayProviderState(
        {
          name: "clone",
          agent: "hermes",
          hermesToolGateways: ["nous-web"],
          hermesInferenceProvider: "clone-hermes-inference",
        },
        {
          sandbox: "clone",
          provider_name: "clone-hermes-tool-gateway",
          inference_provider_name: "hermes-provider",
        },
      ),
    ).toBe(false);
    expect(
      broker.planHermesToolGatewayBrokerRefresh({
        currentBrokerHealthy: true,
        hashMatches: false,
      }),
    ).toBe("preserve-runtime-mismatch");
    expect(
      broker.planHermesToolGatewayBrokerRefresh({
        currentBrokerHealthy: true,
        hashMatches: true,
      }),
    ).toBe("register-with-current");
    expect(
      broker.planHermesToolGatewayBrokerRefresh({
        currentBrokerHealthy: false,
        hashMatches: false,
      }),
    ).toBe("start-or-restart");
  });

  it("refuses a listener whose ownership changes during health verification", async ({
    resources,
  }) => {
    const home = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-broker-ownership-race-"));
    vi.stubEnv("HOME", home);
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);
    const credsDir = path.dirname(broker.HERMES_TOOL_GATEWAY_STATE_DIR);
    const pidPath = path.join(credsDir, "hermes-tool-gateway-broker.pid");
    fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidPath, String(process.pid) + "\n", { mode: 0o600 });
    broker.persistHermesToolGatewayProviderState("clone", "test-only-refresh");

    let controlRequests = 0;
    const control = resources.ownServer(
      http.createServer((_request, response) => {
        controlRequests += 1;
        response.writeHead(200);
        response.end("{}");
      }),
    );
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH, () => resolve());
    });

    function replaceListenerDuringHealth() {
      let listenerOwner = "broker";
      const observations: string[] = [];
      return {
        deps: {
          isPortOwner: () => {
            observations.push("owner:" + listenerOwner);
            return listenerOwner === "broker";
          },
          isHealthy: () => {
            observations.push("health");
            listenerOwner = "foreign";
            return true;
          },
        },
        observations,
      };
    }

    try {
      const preflightRace = replaceListenerDuringHealth();
      expect(() =>
        broker.preflightHermesToolGatewayCloneBinding("clone", preflightRace.deps),
      ).toThrow("health endpoint is not owned by NemoClaw");
      expect(preflightRace.observations).toEqual(["owner:broker", "health", "owner:foreign"]);

      const credentialRace = replaceListenerDuringHealth();
      const refusal = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(
        broker.ensureHermesToolGatewayBroker(
          {
            refreshToken: "test-only-refresh",
            sandboxName: "clone",
          },
          credentialRace.deps,
        ),
      ).toBe(false);
      expect(credentialRace.observations).toEqual(["owner:broker", "health", "owner:foreign"]);
      expect(refusal.mock.calls.flat().join("\n")).toContain(
        String(broker.HERMES_TOOL_GATEWAY_PORT),
      );
      expect(controlRequests).toBe(0);
    } finally {
      delete require.cache[require.resolve(BROKER_WRAPPER)];
    }
  });

  it(
    "reuses its listener and rechecks ownership after the process exits",
    async ({ resources, skip }) => {
      const home = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-broker-ownership-"));
      vi.stubEnv("HOME", home);
      delete require.cache[require.resolve(BROKER_WRAPPER)];
      const broker = require(BROKER_WRAPPER);
      const credsDir = path.dirname(broker.HERMES_TOOL_GATEWAY_STATE_DIR);
      const pidPath = path.join(credsDir, "hermes-tool-gateway-broker.pid");
      const hashPath = path.join(credsDir, "hermes-tool-gateway-broker.hash");
      fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });

      let ownedBroker: ChildProcess;
      try {
        ownedBroker = await startBrokerLikeListener(
          resources,
          broker.HERMES_TOOL_GATEWAY_PORT,
          broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
        );
      } catch (error) {
        skip(
          String(error).includes("EADDRINUSE"),
          `port ${String(broker.HERMES_TOOL_GATEWAY_PORT)} is already held`,
        );
        throw error;
      }

      try {
        fs.writeFileSync(pidPath, `${String(ownedBroker.pid)}\n`, { mode: 0o600 });
        fs.writeFileSync(hashPath, `${broker.brokerRuntimeHash()}\n`, { mode: 0o600 });
        expect(broker.ensureHermesToolGatewayBroker({ startWithoutCredential: true })).toBe(true);

        const ownedBrokerExit = once(ownedBroker, "exit");
        ownedBroker.kill("SIGTERM");
        await ownedBrokerExit;

        try {
          await startForeignHealthListener(resources, broker.HERMES_TOOL_GATEWAY_PORT);
        } catch (error) {
          skip(
            String(error).includes("EADDRINUSE"),
            `port ${String(broker.HERMES_TOOL_GATEWAY_PORT)} is already held`,
          );
          throw error;
        }

        const refusal = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(broker.ensureHermesToolGatewayBroker({ startWithoutCredential: true })).toBe(false);
        expect(refusal.mock.calls.flat().join("\n")).toContain(
          String(broker.HERMES_TOOL_GATEWAY_PORT),
        );
      } finally {
        delete require.cache[require.resolve(BROKER_WRAPPER)];
      }
    },
    BROKER_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a live recorded process that does not own the managed-tool port",
    async ({ resources, skip }) => {
      const home = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-broker-port-owner-"));
      vi.stubEnv("HOME", home);
      delete require.cache[require.resolve(BROKER_WRAPPER)];
      const broker = require(BROKER_WRAPPER);

      try {
        await startForeignHealthListener(resources, broker.HERMES_TOOL_GATEWAY_PORT);
      } catch (error) {
        skip(
          String(error).includes("EADDRINUSE"),
          `port ${String(broker.HERMES_TOOL_GATEWAY_PORT)} is already held`,
        );
        throw error;
      }

      const brokerLikeProcess = resources.ownChild(
        spawn(
          process.execPath,
          [
            "--input-type=commonjs",
            "--eval",
            'process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
            "tool-gateway-broker.ts",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      let brokerLikeOutput = "";
      brokerLikeProcess.stdout?.on("data", (chunk) => {
        brokerLikeOutput += chunk.toString();
      });
      await waitForBrokerCondition(
        "broker-like non-listener",
        brokerLikeProcess,
        () => brokerLikeOutput,
        () => brokerLikeOutput.includes("ready"),
      );

      const credsDir = path.dirname(broker.HERMES_TOOL_GATEWAY_STATE_DIR);
      fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
      const pidPath = path.join(credsDir, "hermes-tool-gateway-broker.pid");
      fs.writeFileSync(pidPath, `${String(brokerLikeProcess.pid)}\n`, { mode: 0o600 });
      let controlRequests = 0;
      const control = resources.ownServer(
        http.createServer((_request, response) => {
          controlRequests += 1;
          response.writeHead(200);
          response.end("{}");
        }),
      );
      await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH, () => resolve());
      });

      try {
        const refusal = vi.spyOn(console, "error").mockImplementation(() => {});
        let preflightError: unknown;
        try {
          broker.preflightHermesToolGatewayCloneBinding("clone");
        } catch (error) {
          preflightError = error;
        }
        expect(String(preflightError)).toContain(String(broker.HERMES_TOOL_GATEWAY_PORT));
        expect(String(preflightError)).toContain("Stop the process holding that port, then retry.");
        // Process identity without listener ownership cannot authorize a
        // credential registration through the private control socket.
        expect(
          broker.ensureHermesToolGatewayBroker({
            refreshToken: "test-only-refresh",
            sandboxName: "sandbox",
          }),
        ).toBe(false);
        expect(refusal.mock.calls.flat().join("\n")).toContain(
          String(broker.HERMES_TOOL_GATEWAY_PORT),
        );
        expect(controlRequests).toBe(0);
      } finally {
        delete require.cache[require.resolve(BROKER_WRAPPER)];
      }
    },
    BROKER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a stale broker-like non-listener alive while replacement startup clears its records",
    async ({ resources, skip }) => {
      const home = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-broker-stale-non-listener-"));
      vi.stubEnv("HOME", home);
      delete require.cache[require.resolve(BROKER_WRAPPER)];
      const broker = require(BROKER_WRAPPER);
      const brokerLikeProcess = resources.ownChild(
        spawn(
          process.execPath,
          [
            "--input-type=commonjs",
            "--eval",
            'process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
            "tool-gateway-broker.ts",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      let brokerLikeOutput = "";
      brokerLikeProcess.stdout?.on("data", (chunk) => {
        brokerLikeOutput += chunk.toString();
      });
      await waitForBrokerCondition(
        "broker-like non-listener",
        brokerLikeProcess,
        () => brokerLikeOutput,
        () => brokerLikeOutput.includes("ready"),
      );

      const credsDir = path.dirname(broker.HERMES_TOOL_GATEWAY_STATE_DIR);
      const pidPath = path.join(credsDir, "hermes-tool-gateway-broker.pid");
      const hashPath = path.join(credsDir, "hermes-tool-gateway-broker.hash");
      fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(pidPath, `${String(brokerLikeProcess.pid)}\n`, { mode: 0o600 });
      fs.writeFileSync(hashPath, "stale-hash\n", { mode: 0o600 });
      fs.writeFileSync(broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH, "stale", { mode: 0o600 });

      let replacementPid = brokerLikeProcess.pid!;
      try {
        try {
          expect(broker.ensureHermesToolGatewayBroker({ startWithoutCredential: true })).toBe(true);
        } catch (error) {
          skip(
            String(error).includes("EADDRINUSE"),
            `port ${String(broker.HERMES_TOOL_GATEWAY_PORT)} is already held`,
          );
          throw error;
        }
        replacementPid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
        expect(replacementPid).not.toBe(brokerLikeProcess.pid);
        expect(fs.readFileSync(hashPath, "utf8").trim()).toBe(broker.brokerRuntimeHash());
        expect(fs.statSync(broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH).isSocket()).toBe(true);
        expect(() => process.kill(brokerLikeProcess.pid!, 0)).not.toThrow();
      } finally {
        try {
          process.kill(replacementPid, "SIGTERM");
        } catch {
          // The recorded process can exit before test cleanup.
        }
        delete require.cache[require.resolve(BROKER_WRAPPER)];
      }
    },
    BROKER_TEST_TIMEOUT_MS,
  );

  it("reports a missing listener inspector once and fails ownership closed", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);
    const diagnostic = vi.fn();
    const runCaptureEx = vi
      .fn()
      .mockReturnValueOnce({ stdout: "", exitCode: 1, timedOut: false })
      .mockReturnValue({ stdout: "", exitCode: null, timedOut: false });
    const deps = {
      isBrokerProcess: () => true,
      runCaptureEx,
      reportError: diagnostic,
    };

    expect(broker.isHermesToolGatewayBrokerPortOwner(42, deps)).toBe(false);
    expect(diagnostic).not.toHaveBeenCalled();
    expect(broker.isHermesToolGatewayBrokerPortOwner(42, deps)).toBe(false);
    expect(broker.isHermesToolGatewayBrokerPortOwner(42, deps)).toBe(false);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Install lsof, then retry."),
    );
    expect(runCaptureEx).toHaveBeenCalledWith([
      "lsof",
      "-ti",
      `:${String(broker.HERMES_TOOL_GATEWAY_PORT)}`,
      "-sTCP:LISTEN",
    ]);
  });

  it("preserves durable state when live credential unregister fails", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);
    const unlinkState = vi.fn();

    expect(
      broker.removeHermesToolGatewayProviderState("clone", {
        getStatePath: () => "/test-only/clone.json",
        controlSocketExists: () => true,
        unregister: () => false,
        unlinkState,
      }),
    ).toBe(false);
    expect(unlinkState).not.toHaveBeenCalled();
  });

  it("creates the private state directory before a broad runtime credential scan", ({
    resources,
  }) => {
    const previousHome = process.env.HOME;
    const home = resources.temporaryDirectory("nemoclaw-hermes-empty-state-");
    try {
      process.env.HOME = home;
      delete require.cache[require.resolve(BROKER_WRAPPER)];
      const broker = require(BROKER_WRAPPER);

      expect(fs.existsSync(broker.HERMES_TOOL_GATEWAY_STATE_DIR)).toBe(false);
      expect(broker.registerHermesToolGatewayRuntimeCredential("test-only-refresh")).toBe(false);
      expect(fs.statSync(broker.HERMES_TOOL_GATEWAY_STATE_DIR).mode & 0o777).toBe(0o700);
    } finally {
      previousHome === undefined
        ? Reflect.deleteProperty(process.env, "HOME")
        : Reflect.set(process.env, "HOME", previousHome);
      delete require.cache[require.resolve(BROKER_WRAPPER)];
    }
  });

  it(
    "uses the current Node runtime for private control requests without a curl dependency",
    {
      timeout: BROKER_TEST_TIMEOUT_MS,
    },
    async ({ resources }) => {
      const previousHome = process.env.HOME;
      const previousPath = process.env.PATH;
      const home = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-hermes-node-control-"));
      try {
        process.env.HOME = home;
        delete require.cache[require.resolve(BROKER_WRAPPER)];
        const broker = require(BROKER_WRAPPER);
        broker.persistHermesToolGatewayProviderState(
          "sandbox",
          "test-only-refresh",
          "test-only-broker",
          "sandbox-hermes-inference",
        );
        const capturePath = path.join(home, "control-request.json");
        const serverSource = [
          'const fs = require("node:fs");',
          'const http = require("node:http");',
          "const [socketPath, capturePath] = process.argv.slice(1);",
          "const server = http.createServer((request, response) => {",
          "  const chunks = [];",
          '  request.on("data", (chunk) => chunks.push(chunk));',
          '  request.on("end", () => {',
          '    const body = Buffer.concat(chunks).toString("utf8");',
          "    fs.writeFileSync(capturePath, JSON.stringify({",
          "      path: request.url,",
          "      body,",
          "    }));",
          '    response.writeHead(body.includes("reject-refresh") ? 503 : 200, {',
          '      "content-type": "application/json",',
          "    });",
          '    response.end("{\\\"registered\\\":true}");',
          "  });",
          "});",
          "server.listen(socketPath, () => {",
          "  fs.chmodSync(socketPath, 0o600);",
          '  process.stdout.write("ready\\n");',
          "});",
          'process.once("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n");
        const server = resources.ownChild(
          spawn(
            process.execPath,
            [
              "--input-type=commonjs",
              "--eval",
              serverSource,
              broker.HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
              capturePath,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          ),
        );
        let output = "";
        server.stdout?.on("data", (chunk) => {
          output += chunk.toString();
        });
        server.stderr?.on("data", (chunk) => {
          output += chunk.toString();
        });
        await waitForBrokerCondition(
          "native Node control server",
          server,
          () => output,
          () => output.includes("ready"),
        );

        process.env.PATH = "/path-with-no-curl";
        expect(
          broker.registerHermesToolGatewayRuntimeCredential("test-only-refresh", "sandbox"),
        ).toBe(true);
        expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
          path: "/credentials/register",
          body: JSON.stringify({
            sandbox: "sandbox",
            refresh_token: "test-only-refresh",
          }),
        });
        broker.persistHermesToolGatewayProviderState(
          "sandbox",
          "reject-refresh",
          "test-only-broker",
          "sandbox-hermes-inference",
        );
        expect(broker.registerHermesToolGatewayRuntimeCredential("reject-refresh", "sandbox")).toBe(
          false,
        );
      } finally {
        previousHome === undefined
          ? Reflect.deleteProperty(process.env, "HOME")
          : Reflect.set(process.env, "HOME", previousHome);
        previousPath === undefined
          ? Reflect.deleteProperty(process.env, "PATH")
          : Reflect.set(process.env, "PATH", previousPath);
        delete require.cache[require.resolve(BROKER_WRAPPER)];
      }
    },
  );

  it("restores a prior destination broker binding and reports cleanup failure", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);
    const previousState = {
      sandbox: "destination",
      provider_name: "destination-hermes-tool-gateway",
      inference_provider_name: "destination-hermes-inference",
      broker_token: "prior-broker-token",
      refresh_token_sha256: sha256("prior-refresh-token"),
    };
    const stagedBinding = {
      activationToken: `nc_activate_${"a".repeat(32)}`,
      brokerToken: "next-broker-token",
    };
    const writeState = vi.fn();
    const removeState = vi.fn(() => true);
    const persistence = () => ({
      file: "/test-only/destination.json",
      brokerToken: stagedBinding.brokerToken,
    });

    expect(() =>
      broker.activateHermesToolGatewayCloneBinding(
        "destination",
        "next-refresh-token",
        stagedBinding,
        {
          readState: () => previousState,
          persistState: persistence,
          controlRequest: () => ({ state: "staged" }),
          writeState,
          removeState,
        },
      ),
    ).toThrow("could not activate destination credentials");
    expect(writeState).toHaveBeenCalledExactlyOnceWith(
      "/test-only/destination.json",
      previousState,
    );
    expect(removeState).not.toHaveBeenCalled();

    const cleanupWriteState = vi.fn();
    expect(() =>
      broker.activateHermesToolGatewayCloneBinding(
        "new-destination",
        "next-refresh-token",
        stagedBinding,
        {
          readState: () => null,
          persistState: () => ({
            file: "/test-only/new-destination.json",
            brokerToken: stagedBinding.brokerToken,
          }),
          controlRequest: () => ({ state: "discarded" }),
          removeState: () => false,
          writeState: cleanupWriteState,
        },
      ),
    ).toThrow("activation cleanup failed");
    expect(cleanupWriteState).not.toHaveBeenCalled();
  });

  it("removes broker state only for the exact registry identity", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);
    const removeState = vi.fn(() => true);
    const entry = {
      name: "clone",
      agent: "hermes",
      hermesToolGateways: [],
      hermesInferenceProvider: "clone-hermes-inference",
    };
    const exactState = {
      sandbox: "clone",
      provider_name: "clone-hermes-tool-gateway",
      inference_provider_name: "clone-hermes-inference",
    };
    const deps = {
      getStatePath: () => "/test-only/clone.json",
      stateExists: () => true,
      removeState,
    };

    expect(
      broker.removeHermesToolGatewayProviderStateForSandboxEntry(
        { ...entry, hermesInferenceProvider: "other-hermes-inference" },
        { ...deps, stateExists: () => false },
      ),
    ).toBe(false);
    expect(
      broker.removeHermesToolGatewayProviderStateForSandboxEntry(entry, {
        ...deps,
        readState: () => ({ ...exactState, sandbox: "other" }),
      }),
    ).toBe(false);
    expect(removeState).not.toHaveBeenCalled();

    expect(
      broker.removeHermesToolGatewayProviderStateForSandboxEntry(entry, {
        ...deps,
        readState: () => exactState,
      }),
    ).toBe(true);
    expect(removeState).toHaveBeenCalledExactlyOnceWith("clone");
  });

  it("probes private broker boot/control and classifies failures before clone mutation", async () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);

    expect(() =>
      broker.probeHermesToolGatewayBrokerStart({
        spawnSyncImpl: () => ({ status: 2 }),
      }),
    ).toThrow("could not bind its runtime endpoints");
    expect(() =>
      broker.probeHermesToolGatewayBrokerStart({
        spawnSyncImpl: () => ({ status: 3 }),
      }),
    ).toThrow("control registration path failed");
    const probePort = await freePort();
    expect(() => broker.probeHermesToolGatewayBrokerStart({ port: probePort })).not.toThrow();
  });

  it(
    "refreshes via header, replaces upstream auth, normalizes responses, and rotates OpenShell storage",
    {
      timeout: BROKER_TEST_TIMEOUT_MS,
    },
    async ({ resources }) => {
      const tmp = resources.temporaryDirectory("nemoclaw-hermes-tool-broker-");
      const stateDir = path.join(tmp, "state");
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(binDir, { recursive: true });
      const openshellLog = path.join(tmp, "openshell.log");
      const openshellBin = path.join(binDir, "openshell");
      fs.writeFileSync(
        openshellBin,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${openshellLog}"`,
          `printf 'refresh=%s\\n' "$NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN" >> "${openshellLog}"`,
          `printf 'openai=%s\\n' "$OPENAI_API_KEY" >> "${openshellLog}"`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const statePath = path.join(stateDir, "sandbox.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            version: 1,
            sandbox: "sandbox",
            provider_name: "sandbox-hermes-tool-gateway",
            credential_env: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
            broker_token: "broker-1",
            broker_token_sha256: sha256("broker-1"),
            refresh_token_sha256: sha256("refresh-1"),
            client_id: "hermes-cli",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      const tokenRequests: Array<{ body: string; refreshHeader?: string }> = [];
      const agentKeyRequests: Array<{ body: string; authorization?: string }> = [];
      const portal = resources.ownServer(
        http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            res.writeHead(200, { "Content-Type": "application/json" });
            if (req.url === "/api/oauth/agent-key") {
              agentKeyRequests.push({
                body,
                authorization: req.headers.authorization,
              });
              res.end(
                JSON.stringify({
                  api_key: "agent-key-2",
                  expires_in: 1800,
                  inference_base_url: "https://inference-api.nousresearch.com/v1",
                }),
              );
              return;
            }
            tokenRequests.push({
              body,
              refreshHeader: req.headers["x-nous-refresh-token"] as string | undefined,
            });
            res.end(
              JSON.stringify({
                access_token: "access-2",
                refresh_token: "refresh-2",
                expires_in: 900,
                token_type: "Bearer",
              }),
            );
          });
        }),
      );
      const portalPort = await listen(portal);

      const upstreamRequests: HermesBrokerUpstreamRequest[] = [];
      const upstream = resources.ownServer(
        http.createServer((req, res) => handleHermesBrokerUpstream(upstreamRequests, req, res)),
      );
      const upstreamPort = await listen(upstream);
      const matrixPath = path.join(tmp, "matrix.json");
      const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
      fs.writeFileSync(
        matrixPath,
        JSON.stringify({
          "nous-web": { service: "firecrawl", upstream: upstreamBase },
          "nous-image": { service: "fal-queue", upstream: upstreamBase },
          "nous-audio": { service: "openai-audio", upstream: upstreamBase },
          "nous-browser": { service: "browser-use", upstream: upstreamBase },
          "nous-code": { service: "modal", upstream: upstreamBase },
        }),
      );
      const brokerPort = await freePort();

      const child = resources.ownChild(
        spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
          env: {
            ...process.env,
            HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
            HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
            HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
            NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
            NEMOCLAW_OPENSHELL_BIN: openshellBin,
            NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "refresh-1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });

      await waitForBrokerCondition(
        "broker health",
        child,
        () => output,
        async () => {
          const response = await fetch(`http://127.0.0.1:${brokerPort}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          return response.status === 200;
        },
      );
      await waitForBrokerCondition(
        "inference provider refresh",
        child,
        () => output,
        () => {
          try {
            return fs
              .readFileSync(openshellLog, "utf8")
              .includes("provider update hermes-provider");
          } catch {
            return false;
          }
        },
      );

      const unknown = await fetch(`http://127.0.0.1:${brokerPort}/unknown`);
      expect(unknown.status).toBe(404);

      const denied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
        headers: { Authorization: "Bearer wrong-broker-token" },
      });
      expect(denied.status).toBe(401);

      const firecrawl = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape?debug=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "refresh-2",
        },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const firecrawlBody = await firecrawl.text();
      expect(firecrawl.status, `${firecrawlBody}\n${output}`).toBe(200);
      expect(firecrawl.headers.get("content-encoding")).toBeNull();
      expect(firecrawl.headers.get("content-length")).toBeNull();
      expect(firecrawl.headers.get("content-md5")).toBeNull();
      expect(firecrawl.headers.get("set-cookie")).toBeNull();
      expect(JSON.parse(firecrawlBody)).toEqual({ ok: true, path: "/v1/scrape?debug=1" });
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.refreshHeader).toBe("refresh-1");
      expect(new URLSearchParams(tokenRequests[0]?.body).get("refresh_token")).toBeNull();
      expect(new URLSearchParams(tokenRequests[0]?.body).get("grant_type")).toBe("refresh_token");
      expect(agentKeyRequests).toHaveLength(1);
      expect(agentKeyRequests[0]?.authorization).toBe("Bearer access-2");
      expect(JSON.parse(agentKeyRequests[0]?.body || "{}")).toEqual({
        min_ttl_seconds: 1800,
      });
      expect(upstreamRequests[0]).toMatchObject({
        url: "/v1/scrape?debug=1",
        authorization: "Bearer access-2",
        acceptEncoding: "identity",
      });
      expect(upstreamRequests[0]?.apiKey).toBeUndefined();

      const rotatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(rotatedState.refresh_token_sha256).toBe(sha256("refresh-2"));
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).toContain(
        "provider update sandbox-hermes-tool-gateway --credential NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
      );
      expect(openshellOutput).toContain("refresh=broker-1");
      expect(openshellOutput).not.toContain("refresh=refresh-2");
      expect(openshellOutput).toContain(
        "provider update hermes-provider --credential OPENAI_API_KEY --config OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1",
      );
      expect(openshellOutput).toContain("openai=agent-key-2");
      expect(rotatedState.inference_provider_name).toBe("hermes-provider");
      expect(rotatedState.inference_credential_env).toBe("OPENAI_API_KEY");
      expect(rotatedState.inference_agent_key_expires_at).toBeTruthy();

      const checks = [
        ["/browser-use/browsers", { "X-Browser-Use-API-Key": "broker-1" }, "browser"],
        ["/fal-queue/fal-ai/test", { Authorization: "Key broker-1" }, "fal"],
        ["/openai-audio/v1/audio/speech", { "openai-api-key": "broker-1" }, "audio"],
        ["/modal/sandboxes", { Authorization: "Bearer broker-1" }, "modal"],
      ] as const;
      for (const [route, headers] of checks) {
        const resp = await fetch(`http://127.0.0.1:${brokerPort}${route}`, {
          method: "POST",
          headers,
          body: "{}",
        });
        expect(resp.status).toBe(200);
      }
      expect(upstreamRequests[1]).toMatchObject({
        url: "/browsers",
        browserUseApiKey: "access-2",
      });
      expect(upstreamRequests[1]?.authorization).toBeUndefined();
      expect(upstreamRequests[2]).toMatchObject({
        url: "/fal-ai/test",
        authorization: "Key access-2",
      });
      expect(upstreamRequests[3]).toMatchObject({
        url: "/v1/audio/speech",
        authorization: "Bearer access-2",
      });
      expect(upstreamRequests[4]).toMatchObject({
        url: "/sandboxes",
        authorization: "Bearer access-2",
      });

      const upstreamRequestCount = upstreamRequests.length;
      const redirect = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/redirect-probe`, {
        headers: { "x-api-key": "refresh-2" },
        redirect: "manual",
      });
      const redirectBody = await redirect.text();
      expect(upstreamRequests.slice(upstreamRequestCount).map(({ url }) => url)).toEqual([
        "/v1/redirect-probe",
      ]);
      expect(redirect.status).toBe(502);
      expect(redirect.headers.get("location")).toBeNull();
      expect(redirect.headers.get("x-redirect-probe")).toBeNull();
      expect(redirectBody).toContain("redirect");
      expect(redirectBody).not.toContain(HERMES_BROKER_REDIRECT_TARGET);
      expect(redirectBody).not.toContain(HERMES_BROKER_REDIRECT_HEADER);
      expect(redirectBody).not.toContain(HERMES_BROKER_REDIRECT_BODY);
      expect(tokenRequests).toHaveLength(1);
      expect(agentKeyRequests).toHaveLength(1);
      expect(output).not.toContain("refresh-1");
      expect(output).not.toContain("refresh-2");
      expect(output).not.toContain("access-2");
      expect(output).not.toContain("sandbox-secret");
      expect(output).not.toContain("agent-key-2");
    },
  );

  it(
    "keeps source and destination credentials live in one broker process and unregisters only the destination",
    {
      timeout: BROKER_TEST_TIMEOUT_MS,
    },
    async ({ resources }) => {
      const tmp = resources.temporaryDirectory("nemoclaw-hermes-tool-broker-coexistence-");
      const stateDir = path.join(tmp, "state");
      const binDir = path.join(tmp, "bin");
      // AF_UNIX paths are short on macOS; the Vitest-owned TMPDIR itself can
      // exceed that limit before the socket name is appended.
      const socketDir = resources.ownDirectory(fs.mkdtempSync("/tmp/nc-hermes-broker-"));
      const controlSocket = path.join(socketDir, "control.sock");
      // The broad starting mode proves that broker startup narrows the directory to 0o700.
      fs.chmodSync(socketDir, 0o777);
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(binDir, { recursive: true });
      const openshellLog = path.join(tmp, "openshell.log");
      const openshellBin = path.join(binDir, "openshell");
      fs.writeFileSync(
        openshellBin,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${openshellLog}"\nexit 0\n`,
        { mode: 0o755 },
      );

      const writeState = (
        sandbox: string,
        brokerToken: string,
        refreshToken: string,
        inferenceProviderName: string,
      ): void => {
        fs.writeFileSync(
          path.join(stateDir, `${sandbox}.json`),
          JSON.stringify(
            {
              version: 1,
              sandbox,
              provider_name: `${sandbox}-hermes-tool-gateway`,
              inference_provider_name: inferenceProviderName,
              inference_credential_env: "OPENAI_API_KEY",
              credential_env: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
              broker_token: brokerToken,
              broker_token_sha256: sha256(brokerToken),
              refresh_token_sha256: sha256(refreshToken),
              client_id: "hermes-cli",
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      };
      writeState("source", "source-broker-token", "source-refresh-token", "hermes-provider");
      writeState(
        "destination",
        "destination-broker-token",
        "destination-refresh-token",
        "destination-hermes-inference",
      );

      const refreshHeaders: string[] = [];
      const portal = resources.ownServer(
        http.createServer((req, res) =>
          handleHermesBrokerCoexistencePortal(refreshHeaders, req, res),
        ),
      );
      const portalPort = await listen(portal);

      const upstreamAuthorizations: string[] = [];
      const upstream = resources.ownServer(
        http.createServer((req, res) => {
          upstreamAuthorizations.push(String(req.headers.authorization || ""));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }),
      );
      const upstreamPort = await listen(upstream);
      const matrixPath = path.join(tmp, "matrix.json");
      fs.writeFileSync(
        matrixPath,
        JSON.stringify({
          "nous-web": {
            service: "firecrawl",
            upstream: `http://127.0.0.1:${upstreamPort}`,
          },
        }),
      );
      const brokerPort = await freePort();
      const child = resources.ownChild(
        spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
          env: {
            ...process.env,
            HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
            HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
            HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
            HERMES_TOOL_GATEWAY_CONTROL_SOCKET: controlSocket,
            HERMES_INFERENCE_AGENT_KEY_REFRESH_INTERVAL_MS: "3600000",
            NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
            NEMOCLAW_OPENSHELL_BIN: openshellBin,
            NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "source-refresh-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      await waitForBrokerCondition(
        "broker and private control socket",
        child,
        () => output,
        async () => {
          const response = await fetch(`http://127.0.0.1:${brokerPort}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          return (
            response.status === 200 &&
            fs.existsSync(controlSocket) &&
            (fs.statSync(controlSocket).mode & 0o777) === 0o600 &&
            (fs.statSync(socketDir).mode & 0o777) === 0o700
          );
        },
      );

      const proxy = (brokerToken: string) =>
        fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
          method: "POST",
          headers: { Authorization: `Bearer ${brokerToken}` },
          body: "{}",
        });

      expect((await proxy("source-broker-token")).status).toBe(200);
      await expect(
        controlRequest(controlSocket, "/credentials/register", {
          sandbox: "destination",
          refresh_token: "destination-refresh-token",
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect((await proxy("destination-broker-token")).status).toBe(200);

      const stagedPayload = {
        sandbox: "staged",
        refresh_token: "staged-refresh-token",
        inference_provider_name: "staged-hermes-inference",
        request_id: `nc_clone_${"3".repeat(32)}`,
        deadline_at_ms: Date.now() + 120_000,
      };
      const stagedResponse = await controlRequest(
        controlSocket,
        "/credentials/stage",
        stagedPayload,
      );
      expect(stagedResponse.status, `${stagedResponse.body}\n${output}`).toBe(200);
      const staged = JSON.parse(stagedResponse.body) as {
        activation_token: string;
        broker_token: string;
      };
      expect(staged.activation_token).toMatch(/^nc_activate_/u);
      expect(staged.broker_token).toMatch(/^nc_broker_/u);
      const repeatedStage = await controlRequest(
        controlSocket,
        "/credentials/stage",
        stagedPayload,
      );
      expect(repeatedStage.status).toBe(200);
      expect(JSON.parse(repeatedStage.body)).toMatchObject(staged);
      writeState("staged", staged.broker_token, "staged-refresh-token", "staged-hermes-inference");
      await expect(
        controlRequest(controlSocket, "/credentials/activate", {
          sandbox: "staged",
          activation_token: staged.activation_token,
          deadline_at_ms: Date.now() + 120_000,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        controlRequest(controlSocket, "/credentials/activate", {
          sandbox: "staged",
          activation_token: staged.activation_token,
          deadline_at_ms: Date.now() + 120_000,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        controlRequest(controlSocket, "/credentials/status", {
          activation_token: staged.activation_token,
        }),
      ).resolves.toMatchObject({ status: 200 });

      const discardedPayload = {
        sandbox: "discarded",
        refresh_token: "discarded-refresh-token",
        inference_provider_name: "discarded-hermes-inference",
        request_id: `nc_clone_${"4".repeat(32)}`,
        deadline_at_ms: Date.now() + 120_000,
      };
      const discardedStage = await controlRequest(
        controlSocket,
        "/credentials/stage",
        discardedPayload,
      );
      expect(discardedStage.status, `${discardedStage.body}\n${output}`).toBe(200);
      const discarded = JSON.parse(discardedStage.body) as { activation_token: string };
      await expect(
        controlRequest(controlSocket, "/credentials/discard", {
          sandbox: "discarded",
          activation_token: discarded.activation_token,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        controlRequest(controlSocket, "/credentials/discard", {
          sandbox: "discarded",
          activation_token: discarded.activation_token,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        controlRequest(controlSocket, "/credentials/stage", discardedPayload),
      ).resolves.toMatchObject({ status: 400 });

      await expect(
        controlRequest(controlSocket, "/credentials/stage", {
          sandbox: "deadline",
          refresh_token: "deadline-refresh-token",
          inference_provider_name: "deadline-hermes-inference",
          request_id: `nc_clone_${"5".repeat(32)}`,
          deadline_at_ms: Date.now() + 50,
        }),
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        controlRequest(controlSocket, "/credentials/stage", {
          sandbox: "Invalid_Sandbox",
          refresh_token: "must-not-reach-portal",
          inference_provider_name: "valid-hermes-inference",
          request_id: `nc_clone_${"6".repeat(32)}`,
          deadline_at_ms: Date.now() + 120_000,
        }),
      ).resolves.toMatchObject({ status: 400 });
      expect(refreshHeaders).not.toContain("must-not-reach-portal");
      expect((await proxy(staged.broker_token)).status).toBe(200);

      await expect(
        controlRequest(controlSocket, "/credentials/unregister", {
          sandbox: "destination",
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect((await proxy("destination-broker-token")).status).toBe(401);
      expect((await proxy("source-broker-token")).status).toBe(200);

      expect(upstreamAuthorizations).toEqual([
        "Bearer access-source",
        "Bearer access-destination",
        "Bearer access-staged",
        "Bearer access-source",
      ]);
      expect(refreshHeaders).toEqual(
        expect.arrayContaining(["source-refresh-token", "destination-refresh-token"]),
      );
      const openshellUpdates = fs.readFileSync(openshellLog, "utf8");
      expect(openshellUpdates).toContain(
        "provider update hermes-provider --credential OPENAI_API_KEY",
      );
      expect(openshellUpdates).toContain(
        "provider update destination-hermes-inference --credential OPENAI_API_KEY",
      );
      expect(openshellUpdates).toContain(
        "provider update staged-hermes-inference --credential OPENAI_API_KEY",
      );
      expect(output).not.toContain("source-refresh-token");
      expect(output).not.toContain("destination-refresh-token");

      const openIncompleteControlRequest = async (): Promise<net.Socket> => {
        const socket = net.createConnection(controlSocket);
        socket.on("error", () => {});
        await once(socket, "connect");
        socket.write(
          [
            "POST /credentials/register HTTP/1.1",
            "Host: localhost",
            "Content-Type: application/json",
            "Content-Length: 200",
            "Connection: keep-alive",
            "",
            '{"sandbox":"destination"',
          ].join("\r\n"),
        );
        return socket;
      };

      const timedOutRequest = await openIncompleteControlRequest();
      const requestTimeoutStartedAt = Date.now();
      await once(timedOutRequest, "close", { signal: AbortSignal.timeout(3_000) });
      expect(Date.now() - requestTimeoutStartedAt).toBeLessThan(3_000);

      const shutdownRequest = await openIncompleteControlRequest();
      const childExit = once(child, "exit", { signal: AbortSignal.timeout(3_000) });
      const shutdownStartedAt = Date.now();
      child.kill("SIGTERM");
      await childExit;
      shutdownRequest.destroy();
      expect(Date.now() - shutdownStartedAt).toBeLessThan(3_000);
    },
  );
});
