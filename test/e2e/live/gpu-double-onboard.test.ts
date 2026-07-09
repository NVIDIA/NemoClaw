// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsInteger42Answer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-gpu-double-onboard";
const PROXY_PORT = process.env.NEMOCLAW_OLLAMA_PROXY_PORT ?? "11435";
const TOKEN_FILE = path.join(os.homedir(), ".nemoclaw", "ollama-proxy-token");
const LIVE_TIMEOUT_MS = 90 * 60_000;

validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_OLLAMA_PROXY_PORT: PROXY_PORT,
    NEMOCLAW_PROVIDER: "ollama",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function nemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 20 * 60_000,
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    timeoutMs,
  });
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await nemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], "cleanup-nemoclaw-destroy").catch(
    () => undefined,
  );
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await host
    .command(
      "bash",
      [
        "-lc",
        "pkill -f 'ollama serve' 2>/dev/null || true; pkill -f 'ollama-auth-proxy' 2>/dev/null || true",
      ],
      {
        artifactName: "cleanup-ollama-processes",
        env: env(),
        timeoutMs: 30_000,
      },
    )
    .catch(() => undefined);
}

async function httpStatus(host: HostCliClient, url: string, artifactName: string, token?: string) {
  const header = token ? `-H 'Authorization: Bearer ${token}'` : "";
  return await host.command(
    "bash",
    ["-lc", `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 ${header} '${url}'`],
    {
      artifactName,
      env: env(),
      timeoutMs: 30_000,
    },
  );
}

function parseReplyCommand(): string {
  return String.raw`python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["choices"][0]["message"]; print((m.get("content") or m.get("reasoning_content") or m.get("reasoning") or "").strip())'`;
}

function fileMode(pathname: string): string {
  return (fs.statSync(pathname).mode & 0o777).toString(8).padStart(3, "0");
}

function chatRequest(model: string): string {
  return JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      },
    ],
    max_tokens: 200,
  });
}

async function expectSandboxInference42(
  sandbox: SandboxClient,
  model: string,
  artifactName: string,
): Promise<void> {
  const response = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      `curl -fsS --max-time 120 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${chatRequest(model)}' | ${parseReplyCommand()}`,
    ],
    {
      artifactName,
      env: env(),
      timeoutMs: 150_000,
    },
  );
  expect(response.exitCode, resultText(response)).toBe(0);
  expect(containsInteger42Answer(response.stdout), resultText(response)).toBe(true);
}

test("gpu double onboard keeps Ollama auth proxy token consistent after re-onboard", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, skip }) => {
  await artifacts.target.declare({
    id: "gpu-double-onboard",
    sandboxName: SANDBOX_NAME,
    proxyPort: PROXY_PORT,
    contracts: [
      "GPU and Docker prerequisites are present",
      "install.sh onboards with the Ollama provider",
      "the persisted Ollama auth-proxy token works after first onboard",
      "nemoclaw onboard --non-interactive --yes recreates the sandbox",
      "the running proxy accepts the persisted token after re-onboard and rejects unauthenticated/wrong-token requests",
      "sandbox inference.local reaches Ollama after re-onboard",
    ],
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: env(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
    skip(`Docker is required: ${resultText(docker)}`);
  }
  const smi = await host.command("nvidia-smi", [], {
    artifactName: "phase-0-nvidia-smi",
    env: env(),
    timeoutMs: 30_000,
  });
  if (smi.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(smi));
    skip(`NVIDIA GPU is required: ${resultText(smi)}`);
  }

  cleanupRegistry.add("remove gpu double-onboard state", () => cleanup(host, sandbox));
  await cleanup(host, sandbox);

  const installOllama = await host.command(
    "bash",
    ["-lc", "command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh"],
    {
      artifactName: "phase-1-install-ollama",
      env: env(),
      timeoutMs: 5 * 60_000,
    },
  );
  expect(installOllama.exitCode, resultText(installOllama)).toBe(0);
  await host.command(
    "bash",
    [
      "-lc",
      "systemctl --user stop ollama 2>/dev/null || true; systemctl stop ollama 2>/dev/null || true; pkill -f 'ollama serve' 2>/dev/null || true; pkill -f 'ollama-auth-proxy' 2>/dev/null || true",
    ],
    {
      artifactName: "phase-1-stop-preexisting-ollama",
      env: env(),
      timeoutMs: 60_000,
    },
  );

  const first = await host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName: "phase-2-install-sh-first-onboard",
    cwd: REPO_ROOT,
    env: env(),
    timeoutMs: 30 * 60_000,
  });
  expect(first.exitCode, resultText(first)).toBe(0);

  const list = await nemoclaw(host, ["list"], "phase-3-nemoclaw-list");
  expect(list.exitCode, resultText(list)).toBe(0);
  expect(list.stdout).toContain(SANDBOX_NAME);
  expect(fs.existsSync(TOKEN_FILE), `${TOKEN_FILE} missing`).toBe(true);
  const tokenAfterFirst = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  expect(tokenAfterFirst.length).toBeGreaterThan(10);
  expect(fileMode(TOKEN_FILE)).toBe("600");

  const model = process.env.NEMOCLAW_MODEL ?? "llama3.2:1b";

  const firstTokenStatus = await httpStatus(
    host,
    `http://127.0.0.1:${PROXY_PORT}/v1/models`,
    "phase-3-proxy-token-status",
    tokenAfterFirst,
  );
  expect(firstTokenStatus.stdout.trim(), resultText(firstTokenStatus)).toBe("200");
  await expectSandboxInference42(sandbox, model, "phase-3-sandbox-inference-first-onboard");

  const reonboard = await nemoclaw(
    host,
    ["onboard", "--non-interactive", "--yes"],
    "phase-4-reonboard",
    env({ NEMOCLAW_RECREATE_SANDBOX: "1" }),
    30 * 60_000,
  );
  expect(reonboard.exitCode, resultText(reonboard)).toBe(0);
  expect(fs.existsSync(TOKEN_FILE), `${TOKEN_FILE} missing after re-onboard`).toBe(true);
  const tokenAfterSecond = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  expect(tokenAfterSecond.length).toBeGreaterThan(10);
  expect(fileMode(TOKEN_FILE)).toBe("600");
  expect(tokenAfterSecond).toBe(tokenAfterFirst);

  const liveStatus = await httpStatus(
    host,
    `http://127.0.0.1:${PROXY_PORT}/api/tags`,
    "phase-5-proxy-live-status",
  );
  expect(liveStatus.stdout.trim()).toMatch(/^[1-9][0-9]{2}$/);
  const authStatus = await httpStatus(
    host,
    `http://127.0.0.1:${PROXY_PORT}/v1/models`,
    "phase-5-proxy-persisted-token-status",
    tokenAfterFirst,
  );
  expect(authStatus.stdout.trim(), resultText(authStatus)).toBe("200");
  const unauthPost = await host.command(
    "bash",
    [
      "-lc",
      `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 -X POST 'http://127.0.0.1:${PROXY_PORT}/api/generate' -d '{}'`,
    ],
    { artifactName: "phase-5-proxy-unauth-post-status", env: env(), timeoutMs: 30_000 },
  );
  expect(unauthPost.stdout.trim()).toBe("401");
  const wrongStatus = await httpStatus(
    host,
    `http://127.0.0.1:${PROXY_PORT}/v1/models`,
    "phase-5-proxy-wrong-token-status",
    `wrong-${Date.now()}`,
  );
  expect(wrongStatus.stdout.trim()).toBe("401");

  await expectSandboxInference42(sandbox, model, "phase-6-sandbox-inference-after-reonboard");

  await cleanup(host, sandbox);
  const registryFile = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
  const registryText = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : "";
  expect(registryText).not.toContain(SANDBOX_NAME);
  await artifacts.target.complete({
    id: "gpu-double-onboard",
    status: "passed",
  });
});
