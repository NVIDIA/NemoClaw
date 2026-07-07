// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the legacy host-side boundary: real Ollama, real auth proxy
 * process, real HTTP auth/inference calls, token persistence, restart from the
 * persisted token, container reachability, and token-divergence repair logic.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PROXY_SCRIPT = path.join(REPO_ROOT, "scripts", "ollama-auth-proxy.js");
const OLLAMA_PORT = parsePort("NEMOCLAW_E2E_OLLAMA_PORT", 11434);
const PROXY_PORT = parsePort("NEMOCLAW_E2E_OLLAMA_PROXY_PORT", 11435);
const MODEL = process.env.NEMOCLAW_E2E_OLLAMA_PROXY_MODEL ?? "qwen2.5:0.5b";
const LIVE_TIMEOUT_MS = 35 * 60_000;

function parsePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port; got ${raw}`);
  }
  return port;
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
  };
}

function token(): string {
  return randomBytes(24).toString("hex");
}

async function bestEffort(run: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup only.
  }
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function spawnLogged(
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", out, out],
  });
  child.once("exit", () => fs.closeSync(out));
  return child;
}

async function expectCommandZero(result: ShellProbeResult, label: string): Promise<void> {
  expect(result.exitCode, `${label}: ${resultText(result)}`).toBe(0);
}

async function curlStatus(
  host: { command: typeof import("../fixtures/clients/host.ts").HostCliClient.prototype.command },
  url: string,
  options: {
    method?: string;
    auth?: string;
    data?: string;
    artifactName: string;
    timeoutMs?: number;
  },
): Promise<string> {
  const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10"];
  if (options.auth) args.push("-H", `Authorization: ${options.auth}`);
  if (options.method) args.push("-X", options.method);
  if (options.data) args.push("-H", "Content-Type: application/json", "-d", options.data);
  args.push(url);
  const result = await host.command("curl", args, {
    artifactName: options.artifactName,
    env: commandEnv(),
    redactionValues: options.auth ? [options.auth] : undefined,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  return result.stdout.trim();
}

async function curlBody(
  host: { command: typeof import("../fixtures/clients/host.ts").HostCliClient.prototype.command },
  url: string,
  options: { auth: string; data?: string; artifactName: string; timeoutMs?: number },
): Promise<ShellProbeResult> {
  const args = ["-sS", "--max-time", "120", "-H", `Authorization: ${options.auth}`];
  if (options.data)
    args.push("-H", "Content-Type: application/json", "-X", "POST", "-d", options.data);
  args.push(url);
  return await host.command("curl", args, {
    artifactName: options.artifactName,
    env: commandEnv(),
    redactionValues: [options.auth],
    timeoutMs: options.timeoutMs ?? 150_000,
  });
}

function openAiContent(body: string): string {
  const parsed = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  const first = parsed.choices?.[0];
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" ? content.trim() : "";
}

function generateResponse(body: string): string {
  const parsed = JSON.parse(body) as { response?: unknown };
  return typeof parsed.response === "string" ? parsed.response.trim() : "";
}

function readTokenFileChecked(tokenFile: string): { mode: string; token: string } {
  const fd = fs.openSync(tokenFile, "r");
  try {
    const stat = fs.fstatSync(fd);
    return {
      mode: (stat.mode & 0o777).toString(8),
      token: fs.readFileSync(fd, "utf8").trim(),
    };
  } finally {
    fs.closeSync(fd);
  }
}

test.skipIf(!shouldRunLiveE2E())(
  "Ollama auth proxy enforces tokens, proxies inference, persists tokens, and recovers",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host }) => {
    await artifacts.target.declare({
      id: "ollama-auth-proxy",
      boundary: "real host Ollama + real Node auth proxy + curl + optional Docker reachability",
      ollamaPort: OLLAMA_PORT,
      proxyPort: PROXY_PORT,
      model: MODEL,
      contracts: [
        "Ollama runs on loopback and serves a small model",
        "the auth proxy rejects unauthenticated and wrong-token requests",
        "the auth proxy forwards valid-token OpenAI and native Ollama inference",
        "the persisted token file exists, is 0600, and matches the running proxy token",
        "the proxy restarts from the persisted token and preserves access",
        "a divergent token file is detected and repaired by restarting the proxy with file token",
      ],
    });

    expect(fs.existsSync(PROXY_SCRIPT), `proxy script missing: ${PROXY_SCRIPT}`).toBe(true);

    const tokenRoot = await mkdtemp(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-"));
    const tokenFile = path.join(tokenRoot, ".nemoclaw", "ollama-proxy-token");
    let ollama: ChildProcess | undefined;
    let proxy: ChildProcess | undefined;
    cleanup.add("stop Ollama auth proxy test processes", async () => {
      await terminate(proxy);
      await terminate(ollama);
      await bestEffort(() => rm(tokenRoot, { force: true, recursive: true }));
    });

    const nodeVersion = await host.command("node", ["--version"], {
      artifactName: "phase-1-node-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    await expectCommandZero(nodeVersion, "node --version");

    const curlVersion = await host.command("curl", ["--version"], {
      artifactName: "phase-1-curl-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    await expectCommandZero(curlVersion, "curl --version");

    const ollamaExists = await host.command("bash", ["-lc", "command -v ollama"], {
      artifactName: "phase-2-command-v-ollama",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    if (ollamaExists.exitCode !== 0) {
      const install = await host.command(
        "bash",
        [
          "-lc",
          // This live E2E intentionally mirrors the legacy user path and
          // exercises the official Ollama installer boundary. The command runs
          // before any repository/GitHub credentials are exposed to children.
          "curl -fsSL https://ollama.com/install.sh | sh",
        ],
        {
          artifactName: "phase-2-install-ollama",
          env: commandEnv(),
          timeoutMs: 10 * 60_000,
        },
      );
      await expectCommandZero(install, "install Ollama");
    }

    await host.command(
      "bash",
      [
        "-lc",
        "pkill -f 'ollama serve' 2>/dev/null || true; systemctl --user stop ollama 2>/dev/null || true; systemctl stop ollama 2>/dev/null || true",
      ],
      {
        artifactName: "phase-2-stop-existing-ollama",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );

    ollama = spawnLogged("ollama", ["serve"], artifacts.pathFor("ollama.log"), {
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const tagsStatus = await curlStatus(host, `http://127.0.0.1:${OLLAMA_PORT}/api/tags`, {
      artifactName: "phase-2-ollama-tags-status",
    });
    expect(tagsStatus).toBe("200");

    const pull = await host.command("ollama", ["pull", MODEL], {
      artifactName: "phase-2-ollama-pull-model",
      env: commandEnv({ OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` }),
      timeoutMs: 15 * 60_000,
    });
    await expectCommandZero(pull, `ollama pull ${MODEL}`);

    const proxyToken = token();
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, `${proxyToken}\n`, { mode: 0o600 });
    proxy = spawnLogged("node", [PROXY_SCRIPT], artifacts.pathFor("ollama-auth-proxy.log"), {
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
      OLLAMA_PROXY_PORT: String(PROXY_PORT),
      OLLAMA_PROXY_TOKEN: proxyToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const correctAuth = `Bearer ${proxyToken}`;
    const aliveStatus = await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/tags`, {
      artifactName: "phase-3-proxy-alive-status",
    });
    expect(aliveStatus).toMatch(/^[1-9][0-9]{2}$/u);

    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/generate`, {
        artifactName: "phase-4-unauthenticated-generate-status",
        method: "POST",
        data: "{}",
      }),
    ).toBe("401");
    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/generate`, {
        artifactName: "phase-4-wrong-token-generate-status",
        auth: "Bearer wrong-token",
        method: "POST",
        data: "{}",
      }),
    ).toBe("401");
    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/tags`, {
        artifactName: "phase-4-correct-token-tags-status",
        auth: correctAuth,
      }),
    ).toBe("200");
    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/tags`, {
        artifactName: "phase-4-unauthenticated-tags-status",
      }),
    ).toBe("401");

    const chatPayload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 50,
    });
    const chat = await curlBody(host, `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      artifactName: "phase-5-chat-completions-through-proxy",
      auth: correctAuth,
      data: chatPayload,
    });
    await expectCommandZero(chat, "chat completions through proxy");
    expect(openAiContent(chat.stdout), chat.stdout.slice(0, 500)).not.toBe("");

    const generate = await curlBody(host, `http://127.0.0.1:${PROXY_PORT}/api/generate`, {
      artifactName: "phase-5-native-generate-through-proxy",
      auth: correctAuth,
      data: JSON.stringify({ model: MODEL, prompt: "Reply with one word: PONG", stream: false }),
    });
    await expectCommandZero(generate, "native generate through proxy");
    expect(generateResponse(generate.stdout), generate.stdout.slice(0, 500)).not.toBe("");

    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
        artifactName: "phase-5-unauthenticated-chat-status",
        method: "POST",
        data: chatPayload,
      }),
    ).toBe("401");

    const persistedTokenFile = readTokenFileChecked(tokenFile);
    expect(persistedTokenFile.mode).toBe("600");
    expect(persistedTokenFile.token).toBe(proxyToken);

    await terminate(proxy);
    proxy = undefined;
    const deadStatus = await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/tags`, {
      artifactName: "phase-7-proxy-dead-status",
    });
    expect(deadStatus === "000" || deadStatus === "").toBe(true);

    const persistedToken = readTokenFileChecked(tokenFile).token;
    proxy = spawnLogged(
      "node",
      [PROXY_SCRIPT],
      artifacts.pathFor("ollama-auth-proxy-restarted.log"),
      {
        OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
        OLLAMA_PROXY_PORT: String(PROXY_PORT),
        OLLAMA_PROXY_TOKEN: persistedToken,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/api/tags`, {
        artifactName: "phase-7-restarted-proxy-status",
      }),
    ).toMatch(/^[1-9][0-9]{2}$/u);
    const recover = await curlBody(host, `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      artifactName: "phase-7-recovery-chat-completions",
      auth: `Bearer ${persistedToken}`,
      data: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 10,
      }),
      timeoutMs: 90_000,
    });
    await expectCommandZero(recover, "chat completions after proxy restart");
    expect(JSON.parse(recover.stdout).choices).toBeTruthy();

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-8-docker-info",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode === 0) {
      const containerReachability = await host.command(
        "docker",
        [
          "run",
          "--rm",
          "--add-host",
          "host.openshell.internal:host-gateway",
          "curlimages/curl:8.10.1",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--connect-timeout",
          "5",
          "--max-time",
          "10",
          `http://host.openshell.internal:${PROXY_PORT}/api/tags`,
        ],
        {
          artifactName: "phase-8-container-proxy-reachability",
          env: commandEnv(),
          timeoutMs: 120_000,
        },
      );
      expect(containerReachability.stdout.trim(), resultText(containerReachability)).toMatch(
        /^[1-9][0-9]{2}$/u,
      );
      const directBackendReachability = await host.command(
        "docker",
        [
          "run",
          "--rm",
          "--add-host",
          "host.openshell.internal:host-gateway",
          "curlimages/curl:8.10.1",
          "-sf",
          "--connect-timeout",
          "3",
          `http://host.openshell.internal:${OLLAMA_PORT}/api/tags`,
        ],
        {
          artifactName: "phase-8-container-direct-backend-negative-probe",
          env: commandEnv(),
          timeoutMs: 120_000,
        },
      );
      expect(directBackendReachability.exitCode, resultText(directBackendReachability)).not.toBe(0);
    }

    const divergentToken = `divergent-${token()}`;
    await writeFile(tokenFile, `${divergentToken}\n`, { mode: 0o600 });
    const oldTokenModels = await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/v1/models`, {
      artifactName: "phase-9-old-token-models-status",
      auth: `Bearer ${persistedToken}`,
    });
    const divergentTokenModels = await curlStatus(
      host,
      `http://127.0.0.1:${PROXY_PORT}/v1/models`,
      {
        artifactName: "phase-9-divergent-token-models-status",
        auth: `Bearer ${divergentToken}`,
      },
    );
    expect(oldTokenModels).toBe("200");
    expect(divergentTokenModels).toBe("401");

    await terminate(proxy);
    proxy = spawnLogged(
      "node",
      [PROXY_SCRIPT],
      artifacts.pathFor("ollama-auth-proxy-divergent.log"),
      {
        OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
        OLLAMA_PROXY_PORT: String(PROXY_PORT),
        OLLAMA_PROXY_TOKEN: divergentToken,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(
      await curlStatus(host, `http://127.0.0.1:${PROXY_PORT}/v1/models`, {
        artifactName: "phase-9-fixed-token-models-status",
        auth: `Bearer ${divergentToken}`,
      }),
    ).toBe("200");
  },
);
