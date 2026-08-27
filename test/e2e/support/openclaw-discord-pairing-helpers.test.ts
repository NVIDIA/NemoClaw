// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertDiscordGatewayCapture,
  DISCORD_GATEWAY_CLIENT_SOURCE,
} from "../live/messaging-providers-helpers.ts";
import {
  buildPairingApproveCommand,
  buildPairingPendingCommand,
  LOAD_CONVERSATION_RUNTIME_SOURCE,
  SLACK_PAIRING_SCRIPT,
  SLACK_PROBE_INPUT_VALIDATION_SOURCE,
} from "../live/openclaw-pairing-helpers.ts";
import { sandboxNode } from "../live/phase6-messaging-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REVISIONED_DISCORD_PLACEHOLDER = "openshell:resolve:env:v2_DISCORD_BOT_TOKEN";
const GATEWAY_ASSERTION_SENTINEL = "test-sentinel-discord-token";

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGTERM");
  child = undefined;
});

function encodeClientText(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  const header = [
    { max: 125, encode: (length: number) => Buffer.from([0x81, 0x80 | length]) },
    {
      max: 0xffff,
      encode: (length: number) => {
        const value = Buffer.alloc(4);
        value[0] = 0x81;
        value[1] = 0x80 | 126;
        value.writeUInt16BE(length, 2);
        return value;
      },
    },
    {
      max: Number.MAX_SAFE_INTEGER,
      encode: (length: number) => {
        const value = Buffer.alloc(10);
        value[0] = 0x81;
        value[1] = 0x80 | 127;
        value.writeBigUInt64BE(BigInt(length), 2);
        return value;
      },
    },
  ]
    .find(({ max }) => body.length <= max)
    ?.encode(body.length);
  return Buffer.concat([header ?? Buffer.alloc(0), mask, masked]);
}

async function waitForPort(portFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return Number(fs.readFileSync(portFile, "utf8").trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("fake Discord Gateway did not write a port file");
}

async function sendDiscordIdentify(port: number, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for fake Discord Gateway"));
    }, 5_000);
    let buffer = Buffer.alloc(0);

    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          "GET /gateway?v=10&encoding=json HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      buffer.toString("latin1").includes("\r\n\r\n")
        ? (() => {
            socket.write(
              encodeClientText(
                JSON.stringify({
                  op: 2,
                  d: {
                    token,
                    intents: 0,
                    properties: { os: "linux", browser: "nemoclaw-e2e", device: "nemoclaw-e2e" },
                  },
                }),
              ),
            );
            clearTimeout(timer);
            socket.end();
            resolve();
          })()
        : undefined;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function localDiscordGatewayClientSource(): string {
  const remoteHost = 'const host = "host.openshell.internal";';
  const localHost = 'const host = "127.0.0.1";';
  const source = DISCORD_GATEWAY_CLIENT_SOURCE.replace(remoteHost, localHost);
  expect(source, "Discord Gateway client host declaration changed").not.toBe(
    DISCORD_GATEWAY_CLIENT_SOURCE,
  );
  return source;
}

describe("OpenClaw Discord pairing helper contracts", () => {
  it("shell-quotes pairing code and user without command substitution", () => {
    const code = "abc$(touch /tmp/e2e-should-not-run)";
    const user = "user`touch /tmp/e2e-should-not-run`";

    const pendingCommand = buildPairingPendingCommand("discord", code, user);
    const approveCommand = buildPairingApproveCommand("discord", code);

    expect(pendingCommand).toContain("'abc$(touch /tmp/e2e-should-not-run)'");
    expect(pendingCommand).toContain("'user`touch /tmp/e2e-should-not-run`'");
    expect(approveCommand).toContain("'abc$(touch /tmp/e2e-should-not-run)'");
    expect(pendingCommand).not.toContain('"abc$(touch /tmp/e2e-should-not-run)"');
    expect(approveCommand).not.toContain('"abc$(touch /tmp/e2e-should-not-run)"');
  });

  it("finds the active OpenClaw package when shell startup shadows openclaw with a function", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-shadowed-"));
    try {
      const packageRoot = path.join(tmp, "openclaw-package");
      const packageBin = path.join(packageRoot, "bin");
      const pathBin = path.join(tmp, "path-bin");
      const home = path.join(tmp, "home");
      const runtimeDir = path.join(packageRoot, "dist/plugin-sdk");
      fs.mkdirSync(packageBin, { recursive: true });
      fs.mkdirSync(pathBin, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw" }),
      );
      fs.writeFileSync(
        path.join(runtimeDir, "conversation-runtime.js"),
        "export const issuePairingChallenge = true;\n",
      );
      fs.writeFileSync(path.join(packageBin, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.symlinkSync(path.join(packageBin, "openclaw"), path.join(pathBin, "openclaw"));
      fs.writeFileSync(
        path.join(home, ".bashrc"),
        "openclaw() { echo shadowed-shell-function; }\nexport -f openclaw\n",
      );

      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: `${LOAD_CONVERSATION_RUNTIME_SOURCE}\nconst runtime = await loadConversationRuntime();\nconsole.log(runtime.issuePairingChallenge);\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: path.join(home, ".bashrc"),
          PATH: `${pathBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("true");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the active OpenClaw package lacks the conversation runtime", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-missing-"));
    try {
      const packageRoot = path.join(tmp, "openclaw-package");
      const packageBin = path.join(packageRoot, "bin");
      const pathBin = path.join(tmp, "path-bin");
      fs.mkdirSync(packageBin, { recursive: true });
      fs.mkdirSync(pathBin, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw" }),
      );
      fs.writeFileSync(path.join(packageBin, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.symlinkSync(path.join(packageBin, "openclaw"), path.join(pathBin, "openclaw"));

      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: `${LOAD_CONVERSATION_RUNTIME_SOURCE}\nawait loadConversationRuntime();\n`,
        encoding: "utf8",
        env: { ...process.env, PATH: `${pathBin}:${process.env.PATH ?? ""}` },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toEqual(
        expect.stringContaining("OpenClaw conversation runtime not found; checked:"),
      );
      expect(result.stderr).toEqual(expect.stringContaining(packageRoot));
      expect(result.stderr).toEqual(expect.not.stringContaining("/usr/local/bin/openclaw"));
      expect(result.stderr).toEqual(expect.not.stringContaining("/usr/bin/openclaw"));
      expect(result.stderr).toEqual(expect.not.stringContaining("shadowed-shell-function"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "missing fake port",
      env: { FAKE_SLACK_API_PORT: "", HTTP_PROXY: "", http_proxy: "" },
      error: "FAKE_SLACK_API_PORT must be an integer in 1..65535",
    },
    {
      name: "out-of-range fake port",
      env: { FAKE_SLACK_API_PORT: "70000", HTTP_PROXY: "", http_proxy: "" },
      error: "FAKE_SLACK_API_PORT must be an integer in 1..65535",
    },
    {
      name: "malformed proxy",
      env: { FAKE_SLACK_API_PORT: "12345", HTTP_PROXY: "http://[", http_proxy: "" },
      error: "HTTP proxy for Slack pairing probe is malformed",
    },
    {
      name: "non-HTTP proxy",
      env: { FAKE_SLACK_API_PORT: "12345", HTTP_PROXY: "socks5://127.0.0.1:1080", http_proxy: "" },
      error: "Slack pairing probe only supports HTTP proxies",
    },
    {
      name: "invalid proxy port",
      env: { FAKE_SLACK_API_PORT: "12345", HTTP_PROXY: "http://127.0.0.1:70000", http_proxy: "" },
      error: "HTTP proxy for Slack pairing probe is malformed",
    },
    {
      name: "unexpected valid proxy host",
      env: { FAKE_SLACK_API_PORT: "12345", HTTP_PROXY: "http://127.0.0.1:3128", http_proxy: "" },
      error: "unexpected HTTP proxy for Slack pairing probe",
    },
  ])("fails closed on invalid Slack probe input before network access: $name", ({ env, error }) => {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: `${SLACK_PROBE_INPUT_VALIDATION_SOURCE}\nlet networkAttempted = false;\ntry { parseFakeSlackPort(); parseProxyTarget(); networkAttempted = true; } catch (error) { console.error(error.message); console.error("NETWORK_ATTEMPTED=" + networkAttempted); process.exit(1); }\n`,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toEqual(expect.stringContaining(error));
    expect(result.stderr).toEqual(expect.stringContaining("NETWORK_ATTEMPTED=false"));
  });

  it("keeps the shared Discord Gateway client valid for sandbox node heredoc", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: DISCORD_GATEWAY_CLIENT_SOURCE,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(DISCORD_GATEWAY_CLIENT_SOURCE).toContain('"\\r\\n"');
    expect(DISCORD_GATEWAY_CLIENT_SOURCE).toContain("IDENTIFY_SENT_PLACEHOLDER");
  });

  it("uses distinct ports on the OpenShell host for Slack REST and websocket traffic", () => {
    expect(SLACK_PAIRING_SCRIPT).toContain(
      'function receiveSlackSocketEvent() {\n  const host = "host.openshell.internal";',
    );
    expect(SLACK_PAIRING_SCRIPT).toContain(
      'function postPairingReply(text, channel) {\n  const host = "host.openshell.internal";',
    );
    expect(SLACK_PAIRING_SCRIPT).toContain(
      'parseFakeSlackPort("FAKE_SLACK_WEBSOCKET_PORT")',
    );
  });

  it("uses the revision-scoped Slack credential references issued to the sandbox", () => {
    expect(SLACK_PAIRING_SCRIPT).toContain(
      'parseManagedCredentialReference("SLACK_APP_TOKEN")',
    );
    expect(SLACK_PAIRING_SCRIPT).toContain(
      'parseManagedCredentialReference("SLACK_BOT_TOKEN")',
    );
    expect(SLACK_PAIRING_SCRIPT).not.toContain(
      "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    );
    expect(SLACK_PAIRING_SCRIPT).not.toContain(
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
  });

  it.each([
    { name: "missing", value: "" },
    { name: "unscoped", value: "openshell:resolve:env:SLACK_APP_TOKEN" },
    { name: "wrong credential", value: "openshell:resolve:env:v2_SLACK_BOT_TOKEN" },
    { name: "raw token", value: "xapp-raw-slack-token" },
  ])("rejects a $name Slack app credential before network access", ({ value }) => {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: `${SLACK_PROBE_INPUT_VALIDATION_SOURCE}\nlet networkAttempted = false;\ntry { parseManagedCredentialReference("SLACK_APP_TOKEN"); networkAttempted = true; } catch (error) { console.error(error.message); console.error("NETWORK_ATTEMPTED=" + networkAttempted); process.exit(1); }\n`,
      encoding: "utf8",
      env: { ...process.env, SLACK_APP_TOKEN: value },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SLACK_APP_TOKEN must be the revision-scoped OpenShell credential reference",
    );
    expect(result.stderr).toContain("NETWORK_ATTEMPTED=false");
    expect(result.stderr).not.toContain("xapp-raw-slack-token");
  });

  it("sends the revision-scoped Discord placeholder through the shared gateway client (#10155)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discord-gateway-proof-revision-"));
    const captureFile = path.join(tmp, "capture.jsonl");
    const portFile = path.join(tmp, "port");
    try {
      child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "test/e2e/lib/fake-discord-gateway.cjs")],
        {
          env: {
            ...process.env,
            FAKE_DISCORD_GATEWAY_HOST: "127.0.0.1",
            FAKE_DISCORD_GATEWAY_PORT: "0",
            FAKE_DISCORD_GATEWAY_PORT_FILE: portFile,
            FAKE_DISCORD_GATEWAY_CAPTURE_FILE: captureFile,
            FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: REVISIONED_DISCORD_PLACEHOLDER,
          },
          stdio: "ignore",
        },
      );
      const port = await waitForPort(portFile);
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: localDiscordGatewayClientSource(),
        encoding: "utf8",
        env: {
          ...process.env,
          DISCORD_BOT_TOKEN: REVISIONED_DISCORD_PLACEHOLDER,
          FAKE_DISCORD_IDENTIFY_MODE: "revisioned-discord-env",
          FAKE_DISCORD_GATEWAY_PORT: String(port),
          HTTP_PROXY: "",
          http_proxy: "",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("IDENTIFY_SENT_PLACEHOLDER");
      expect(result.stdout).toContain("READY");
      expect(result.stdout).toContain("HEARTBEAT_ACK");

      const identify = fs
        .readFileSync(captureFile, "utf8")
        .trim()
        .split(/\n+/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "identify");
      expect(identify).not.toHaveProperty("token");
      expect(identify?.tokenMatchesExpected).toBe(true);
      expect(identify?.tokenLooksPlaceholder).toBe(true);
    } finally {
      child?.kill("SIGTERM");
      child = undefined;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "missing", value: "" },
    { name: "canonical", value: "openshell:resolve:env:DISCORD_BOT_TOKEN" },
    { name: "wrong credential", value: "openshell:resolve:env:v2_SLACK_BOT_TOKEN" },
    { name: "raw token", value: "raw-discord-token" },
  ])("rejects a $name Discord proof credential before network access (#10155)", ({ value }) => {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: localDiscordGatewayClientSource(),
      encoding: "utf8",
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: value,
        FAKE_DISCORD_IDENTIFY_MODE: "revisioned-discord-env",
        FAKE_DISCORD_GATEWAY_PORT: "12345",
        HTTP_PROXY: "",
        http_proxy: "",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Discord Gateway proof requires the revision-scoped DISCORD_BOT_TOKEN placeholder",
    );
    expect(result.stderr).not.toContain("ECONNREFUSED");
    expect(result.stderr).not.toContain("raw-discord-token");
  });

  it.each([
    {
      name: "malformed proxy",
      env: { HTTP_PROXY: "http://[", http_proxy: "" },
      error: "HTTP proxy for Discord Gateway proof is malformed",
    },
    {
      name: "non-HTTP proxy",
      env: { HTTP_PROXY: "socks5://127.0.0.1:1080", http_proxy: "" },
      error: "Discord Gateway proof only supports HTTP proxies",
    },
    {
      name: "invalid proxy port",
      env: { HTTP_PROXY: "http://127.0.0.1:70000", http_proxy: "" },
      error: "HTTP proxy for Discord Gateway proof is malformed",
    },
    {
      name: "unexpected valid proxy host",
      env: { HTTP_PROXY: "http://127.0.0.1:3128", http_proxy: "" },
      error: "unexpected HTTP proxy for Discord Gateway proof",
    },
  ])(
    "fails closed on invalid Discord Gateway proxy input before network access: $name",
    ({ env, error }) => {
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: `${DISCORD_GATEWAY_CLIENT_SOURCE}\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          DISCORD_BOT_TOKEN: REVISIONED_DISCORD_PLACEHOLDER,
          FAKE_DISCORD_IDENTIFY_MODE: "revisioned-discord-env",
          FAKE_DISCORD_GATEWAY_PORT: "12345",
          ...env,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toEqual(expect.stringContaining(error));
      expect(result.stderr).not.toContain("ECONNREFUSED");
    },
  );

  it("rejects malformed sandboxNode env keys before sandbox execution", async () => {
    const execShell = vi.fn(async () => {
      throw new Error("execShell should not run");
    });

    await expect(
      sandboxNode(
        { execShell } as never,
        "openclaw-discord-env-key",
        "console.log('ok');",
        { "BAD=$(touch /tmp/e2e-should-not-run)": "value" },
        { artifactName: "discord-invalid-env-key" },
      ),
    ).rejects.toThrow("invalid env key");
    expect(execShell).not.toHaveBeenCalled();
  });

  it("fake Discord Gateway capture omits raw identify token while preserving rewrite booleans", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-discord-gateway-"));
    const captureFile = path.join(tmp, "capture.jsonl");
    const portFile = path.join(tmp, "port");
    const sentinel = "test-sentinel-discord-token";
    try {
      child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "test/e2e/lib/fake-discord-gateway.cjs")],
        {
          env: {
            ...process.env,
            FAKE_DISCORD_GATEWAY_HOST: "127.0.0.1",
            FAKE_DISCORD_GATEWAY_PORT: "0",
            FAKE_DISCORD_GATEWAY_PORT_FILE: portFile,
            FAKE_DISCORD_GATEWAY_CAPTURE_FILE: captureFile,
            FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: sentinel,
          },
          stdio: "ignore",
        },
      );
      const port = await waitForPort(portFile);
      await sendDiscordIdentify(port, sentinel);
      await new Promise((resolve) => setTimeout(resolve, 50));

      assertDiscordGatewayCapture(captureFile, sentinel);
      const serialized = fs.readFileSync(captureFile, "utf8");
      const identify = serialized
        .trim()
        .split(/\n+/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "identify");

      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain("malformed_text");
      expect(identify).not.toHaveProperty("token");
      expect(identify?.tokenMatchesExpected).toBe(true);
      expect(identify?.tokenLooksPlaceholder).toBe(false);
    } finally {
      child?.kill("SIGTERM");
      child = undefined;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    {
      caseName: "IDENTIFY includes a token field",
      expectedMessage: "persisted token field",
      rows: [
        {
          event: "identify",
          token: GATEWAY_ASSERTION_SENTINEL,
          tokenMatchesExpected: true,
          tokenLooksPlaceholder: false,
        },
      ],
    },
    {
      caseName: "another capture row includes the raw token",
      expectedMessage: "persisted raw token",
      rows: [
        { event: "identify", tokenMatchesExpected: true, tokenLooksPlaceholder: false },
        { event: "diagnostic", value: GATEWAY_ASSERTION_SENTINEL },
      ],
    },
  ])(
    "does not include the Discord token in gateway assertion failures when $caseName",
    (testCase) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-discord-gateway-failure-"));
      const captureFile = path.join(tmp, "capture.jsonl");

      try {
        fs.writeFileSync(
          captureFile,
          `${testCase.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
        let failure: unknown;
        try {
          assertDiscordGatewayCapture(captureFile, GATEWAY_ASSERTION_SENTINEL);
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(testCase.expectedMessage);
        expect((failure as Error).message).not.toContain(GATEWAY_ASSERTION_SENTINEL);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
