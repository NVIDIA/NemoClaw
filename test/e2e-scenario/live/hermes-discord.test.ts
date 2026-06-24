// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-hermes-discord-e2e.sh. */

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import { sandboxAccessEnv, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { type FakeDockerApi, startFakeDockerApi } from "./messaging-providers-helpers.ts";
import {
  bestEffort,
  dockerInfo,
  expectExitZero,
  phase6Env,
  resultText,
  sandboxEncodedSh,
  sandboxNode,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-discord";
validateSandboxName(SANDBOX_NAME);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "test-fake-discord-token-hermes-e2e";
const DISCORD_SERVER_IDS = process.env.DISCORD_SERVER_IDS ?? "1491590992753590594";
const DISCORD_ALLOWED_IDS = process.env.DISCORD_ALLOWED_IDS ?? "1005536447329222676";
const DISCORD_REQUIRE_MENTION = process.env.DISCORD_REQUIRE_MENTION ?? "0";
const HERMES_HEALTH_URL = "http://localhost:8642/health";
const FAKE_DISCORD_HOST = "host.docker.internal";
const LIVE_TIMEOUT_MS = 75 * 60_000;

function commandEnv(apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return phase6Env({
    sandboxName: SANDBOX_NAME,
    agent: "hermes",
    apiKey,
    extra: {
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER ?? "custom",
      NEMOCLAW_ENDPOINT_URL:
        process.env.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: process.env.NEMOCLAW_MODEL ?? "nvidia/nvidia/nemotron-3-super-v3",
      NEMOCLAW_COMPAT_MODEL:
        process.env.NEMOCLAW_COMPAT_MODEL ??
        process.env.NEMOCLAW_MODEL ??
        "nvidia/nvidia/nemotron-3-super-v3",
      NEMOCLAW_PREFERRED_API: process.env.NEMOCLAW_PREFERRED_API ?? "openai-completions",
      DISCORD_BOT_TOKEN: DISCORD_TOKEN,
      DISCORD_SERVER_IDS,
      DISCORD_ALLOWED_IDS,
      DISCORD_REQUIRE_MENTION,
      ...(apiKey ? { COMPATIBLE_API_KEY: apiKey } : {}),
      ...extra,
    },
  });
}

function redactions(apiKey: string): string[] {
  return [apiKey, DISCORD_TOKEN, Buffer.from(DISCORD_TOKEN, "utf8").toString("base64")];
}

function normalizedCsv(value: string): string {
  return value.replace(/\s+/g, "");
}

async function cleanupHermesDiscord(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
  prefix: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("nemoclaw", [sandboxName, "destroy", "--yes"], {
      artifactName: `${prefix}-nemoclaw-destroy`,
      env,
      redactionValues,
      timeoutMs: 15 * 60_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", sandboxName], {
      artifactName: `${prefix}-openshell-sandbox-delete`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${prefix}-openshell-gateway-destroy`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    }),
  );
}

async function startHermesFakeDiscordGateway(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  env: NodeJS.ProcessEnv,
  token: string,
  redactionValues: string[],
): Promise<FakeDockerApi> {
  return startFakeDockerApi(host, cleanup.add.bind(cleanup), {
    kind: "discord-gateway",
    imageScript: "fake-discord-gateway.cjs",
    containerPrefix: "nemoclaw-fake-discord-hermes",
    portEnv: "FAKE_DISCORD_GATEWAY_PORT",
    portFileEnv: "FAKE_DISCORD_GATEWAY_PORT_FILE",
    captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
    expectedEnv: { FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: token },
    env,
    redactionValues,
  });
}

async function applyHermesFakeDiscordPolicy(options: {
  host: HostCliClient;
  sandboxName: string;
  api: FakeDockerApi;
  env: NodeJS.ProcessEnv;
  redactions: string[];
}): Promise<void> {
  const result = await options.host.command(
    "openshell",
    [
      "policy",
      "update",
      options.sandboxName,
      "--add-endpoint",
      `${FAKE_DISCORD_HOST}:${options.api.port}:read-write:websocket:enforce:websocket-credential-rewrite,allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
      "--add-allow",
      `${FAKE_DISCORD_HOST}:${options.api.port}:GET:/**`,
      "--add-allow",
      `${FAKE_DISCORD_HOST}:${options.api.port}:WEBSOCKET_TEXT:/**`,
      "--binary",
      "/usr/local/bin/node",
      "--binary",
      "/usr/bin/node",
      "--binary",
      "/usr/local/bin/python3",
      "--binary",
      "/usr/bin/python3",
      "--binary",
      "/opt/hermes/.venv/bin/python",
      "--wait",
    ],
    {
      artifactName: "apply-hermes-fake-discord-gateway-policy",
      env: options.env,
      redactionValues: options.redactions,
      timeoutMs: 120_000,
    },
  );
  expectExitZero(result, "apply Hermes fake Discord Gateway policy");
}

function assertDiscordGatewayCapture(captureFile: string, expectedToken: string): void {
  const rows = fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const identify = rows.filter((row) => row.event === "identify").at(-1);
  expect(identify, "fake Discord Gateway did not capture IDENTIFY").toBeTruthy();
  expect(identify?.tokenMatchesExpected, "Discord host-side token rewrite").toBe(true);
  expect(identify?.tokenLooksPlaceholder, "Discord placeholder leaked to fake Gateway").toBe(false);
  expect(JSON.stringify(rows), "fake Gateway capture must not persist the raw token").not.toContain(
    expectedToken,
  );
}

const HERMES_DISCORD_PYTHON_GATEWAY_PROOF = String.raw`
import asyncio
import inspect
import os
from pathlib import Path

try:
    import aiohttp
    import discord
    from discord.http import DiscordClientWebSocketResponse
    from yarl import URL
except Exception as exc:
    print(f"IMPORT_DISCORD_FAILED {type(exc).__name__}: {exc}")
    raise SystemExit(0)


def read_env_token():
    env_text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
    for line in env_text.splitlines():
        if line.startswith("DISCORD_BOT_TOKEN="):
            return line.split("=", 1)[1]
    raise RuntimeError("missing DISCORD_BOT_TOKEN in /sandbox/.hermes/.env")


def note_heartbeat_ack(ws, results, previous_ack=None):
    keep_alive = getattr(ws, "_keep_alive", None)
    if keep_alive is None:
        return False
    current_ack = getattr(keep_alive, "_last_ack", None)
    latency = getattr(keep_alive, "latency", float("inf"))
    if previous_ack is not None and current_ack == previous_ack:
        return False
    if latency == float("inf"):
        return False
    if "HEARTBEAT_ACK" not in results:
        results.append("HEARTBEAT_ACK")
    return True


async def wait_for_ready(ws, results):
    for _ in range(20):
        await ws.poll_event()
        note_heartbeat_ack(ws, results)
        if getattr(ws, "session_id", None):
            results.append("READY")
            return
    raise AssertionError("timed out waiting for READY")


async def wait_for_heartbeat_ack(ws, results):
    if "HEARTBEAT_ACK" in results:
        return
    keep_alive = getattr(ws, "_keep_alive", None)
    previous_ack = getattr(keep_alive, "_last_ack", None)
    for _ in range(20):
        await ws.poll_event()
        if note_heartbeat_ack(ws, results, previous_ack):
            return
    raise AssertionError("timed out waiting for HEARTBEAT_ACK")


async def main():
    port = int(os.environ["FAKE_DISCORD_GATEWAY_CLIENT_PORT"])
    host = os.environ.get("FAKE_DISCORD_GATEWAY_CLIENT_HOST", "host.docker.internal")
    token = read_env_token()
    results = []
    client = discord.Client(intents=discord.Intents.none())
    setup = getattr(client, "_async_setup_hook", None)
    if setup is not None:
        await setup()
    client.http.token = token
    client.http.proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    client.http.proxy_auth = None
    if getattr(client.http, "connector", None) is discord.utils.MISSING:
        client.http.connector = aiohttp.TCPConnector(limit=0)
    setattr(
        client.http,
        "_HTTPClient__session",
        aiohttp.ClientSession(
            connector=client.http.connector,
            ws_response_class=DiscordClientWebSocketResponse,
            trace_configs=None,
            cookie_jar=aiohttp.DummyCookieJar(),
        ),
    )
    client.http._global_over = asyncio.Event()
    client.http._global_over.set()
    try:
        from_client = discord.gateway.DiscordWebSocket.from_client
        kwargs = {"gateway": URL(f"ws://{host}:{port}/gateway")}
        params = inspect.signature(from_client).parameters
        if "initial" in params:
            kwargs["initial"] = False
        if "compress" in params:
            kwargs["compress"] = False
        elif "zlib" in params:
            kwargs["zlib"] = False
        ws = await from_client(client, **kwargs)
        results.append("UPGRADE")
        results.append("HELLO")
        if "openshell:resolve:env:" in token:
            results.append("IDENTIFY_SENT_PLACEHOLDER")
        await wait_for_ready(ws, results)
        await ws.send_as_json({"op": 1, "d": ws.sequence})
        await wait_for_heartbeat_ack(ws, results)
        close = getattr(ws, "close", None)
        if close is not None:
            await close(code=1000)
    finally:
        await client.close()
    print("\n".join(results))


try:
    asyncio.run(main())
except Exception as exc:
    print(f"ERROR {type(exc).__name__}: {exc}")
`;

async function runHermesPythonDiscordGatewayProof(
  sandbox: SandboxClient,
  port: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  return sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    `FAKE_DISCORD_GATEWAY_CLIENT_HOST=${shellQuote(FAKE_DISCORD_HOST)} FAKE_DISCORD_GATEWAY_CLIENT_PORT=${shellQuote(port)} /opt/hermes/.venv/bin/python - <<'PY'\n${HERMES_DISCORD_PYTHON_GATEWAY_PROOF}\nPY\n`,
    [],
    {
      artifactName: "hermes-python-discord-gateway-proof",
      redactionValues,
      timeoutMs: 60_000,
    },
  );
}

async function assertRawTokenAbsentFromFiles(
  sandbox: SandboxClient,
  token: string,
  redactionValues: string[],
): Promise<void> {
  const tokenB64 = Buffer.from(token, "utf8").toString("base64");
  const probe = await sandboxEncodedSh(
    sandbox,
    SANDBOX_NAME,
    `token="$(printf %s ${shellQuote(tokenB64)} | base64 -d)"\nif grep -Fq "$token" /sandbox/.hermes/config.yaml /sandbox/.hermes/.env 2>/dev/null; then echo LEAK; else echo OK; fi`,
    [],
    { artifactName: "raw-discord-token-config-env-probe", redactionValues },
  );
  expectExitZero(probe, "raw Discord token config probe");
  expect(probe.stdout.trim()).toBe("OK");
}

async function rawTokenSurfaceProbe(
  sandbox: SandboxClient,
  token: string,
  surface: "env" | "process" | "filesystem",
  artifactName: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  const tokenB64 = Buffer.from(token, "utf8").toString("base64");
  const script =
    surface === "env"
      ? `token="$(printf %s ${shellQuote(tokenB64)} | base64 -d)"\nif env 2>/dev/null | grep -Fq "$token"; then echo FOUND_TOKEN; elif env 2>/dev/null | grep -q '^DISCORD_PROXY='; then echo FOUND_DISCORD_PROXY; else echo ABSENT; fi`
      : surface === "process"
        ? `token="$(printf %s ${shellQuote(tokenB64)} | base64 -d)"\nif cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -Fq "$token"; then echo FOUND_TOKEN; else echo ABSENT; fi`
        : `token="$(printf %s ${shellQuote(tokenB64)} | base64 -d)"\nhit="$(grep -rFlm1 -F "$token" /sandbox /home /etc /tmp /var 2>/dev/null | head -1 || true)"\nif [ -n "$hit" ]; then printf 'FOUND_TOKEN %s\\n' "$hit"; else echo ABSENT; fi`;
  return sandboxEncodedSh(sandbox, SANDBOX_NAME, script, [], {
    artifactName,
    redactionValues,
    timeoutMs: surface === "filesystem" ? 120_000 : 60_000,
  });
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "hermes-discord: Hermes Discord schema, credential isolation, native gateway rewrite, and rebuild credential reuse",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = commandEnv(apiKey);
    const redactionValues = redactions(apiKey);

    await artifacts.writeJson("scenario.json", {
      id: "hermes-discord",
      legacySource: "test/e2e/test-hermes-discord-e2e.sh",
      boundary:
        "install.sh --non-interactive Hermes sandbox + Discord config + OpenShell provider rewrite + sandbox leak probes + rebuild credential reuse",
      sandboxName: SANDBOX_NAME,
      discordServerIds: DISCORD_SERVER_IDS,
      discordAllowedIds: DISCORD_ALLOWED_IDS,
      discordRequireMention: DISCORD_REQUIRE_MENTION,
    });

    cleanup.add(`destroy Hermes Discord sandbox ${SANDBOX_NAME}`, () =>
      cleanupHermesDiscord(host, SANDBOX_NAME, env, redactionValues, "cleanup-hermes-discord"),
    );

    await cleanupHermesDiscord(host, SANDBOX_NAME, env, redactionValues, "preclean-hermes-discord");

    const docker = await dockerInfo(host, env);
    expectExitZero(docker, "Docker is running");
    expect(process.env.NEMOCLAW_NON_INTERACTIVE ?? env.NEMOCLAW_NON_INTERACTIVE).toBe("1");
    expect(
      process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE ?? env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE,
    ).toBe("1");

    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-1-install-hermes-discord",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 60 * 60_000,
    });
    expectExitZero(install, "install.sh --non-interactive with Hermes Discord");

    const cliProbe = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && openshell --version"],
      {
        artifactName: "phase-1-cli-probe",
        env,
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(cliProbe, "nemoclaw and openshell installed");
    expect(cliProbe.stdout).toContain("nemoclaw");

    const list = await host.command("nemoclaw", ["list"], {
      artifactName: "phase-2-nemoclaw-list",
      env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(list, "nemoclaw list");
    expect(resultText(list)).toContain(SANDBOX_NAME);

    const provider = await host.command(
      "openshell",
      ["provider", "get", `${SANDBOX_NAME}-discord-bridge`],
      {
        artifactName: "phase-2-discord-provider-get",
        env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    expectExitZero(provider, "Discord provider exists in gateway");

    let health: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      health = await sandboxSh(sandbox, SANDBOX_NAME, `curl -sf ${shellQuote(HERMES_HEALTH_URL)}`, {
        artifactName: `phase-3-hermes-health-${attempt}`,
        redactionValues,
        timeoutMs: 20_000,
      });
      switch (health.exitCode === 0 && /"ok"/i.test(resultText(health))) {
        case true:
          attempt = 16;
          break;
        default:
          await sleep(4_000);
      }
    }
    expect(health, "Hermes health probe did not run").toBeTruthy();
    expect(health?.exitCode, health ? resultText(health) : "missing health result").toBe(0);
    expect(resultText(health!)).toMatch(/"ok"/i);

    const expectedRequireMention = DISCORD_REQUIRE_MENTION === "0" ? "false" : "true";
    const configProbe = await sandboxEncodedSh(
      sandbox,
      SANDBOX_NAME,
      `EXPECTED_REQUIRE_MENTION=${shellQuote(expectedRequireMention)} python3 - <<'PY'
import os
import sys, yaml
with open("/sandbox/.hermes/config.yaml", "r", encoding="utf-8") as f:
    text = f.read()
cfg = yaml.safe_load(text) or {}
errors = []
discord = cfg.get("discord")
if not isinstance(discord, dict):
    errors.append("missing top-level discord")
else:
    expected = {
        "require_mention": os.environ["EXPECTED_REQUIRE_MENTION"] == "true",
        "free_response_channels": "",
        "allowed_channels": "",
        "auto_thread": True,
        "reactions": True,
        "channel_prompts": {},
    }
    for key, value in expected.items():
        if discord.get(key) != value:
            errors.append(f"discord.{key}={discord.get(key)!r} expected {value!r}")
platforms = cfg.get("platforms")
if not isinstance(platforms, dict):
    errors.append("missing platforms")
else:
    discord_platform = platforms.get("discord")
    if discord_platform != {"enabled": True}:
        errors.append(f"platforms.discord={discord_platform!r} expected enabled true")
    if not isinstance(platforms.get("api_server"), dict):
        errors.append("platforms.api_server missing")
if "DISCORD_BOT_TOKEN" in text:
    errors.append("config.yaml contains DISCORD_BOT_TOKEN")
if errors:
    print("FAIL " + "; ".join(errors))
    raise SystemExit(1)
print("OK")
PY`,
      [],
      { artifactName: "phase-4-hermes-discord-config-shape", redactionValues },
    );
    expectExitZero(configProbe, "Hermes Discord config shape");
    expect(configProbe.stdout.trim()).toBe("OK");

    const envProbe = await sandboxEncodedSh(
      sandbox,
      SANDBOX_NAME,
      `EXPECTED_ALLOWED_USERS=${shellQuote(normalizedCsv(DISCORD_ALLOWED_IDS))} EXPECTED_GUILD_IDS=${shellQuote(normalizedCsv(DISCORD_SERVER_IDS))} python3 - <<'PY'
import os
from pathlib import Path
text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
lines = text.splitlines()
errors = []
required = [
    "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
    f"NEMOCLAW_DISCORD_GUILD_IDS={os.environ['EXPECTED_GUILD_IDS']}",
    f"DISCORD_ALLOWED_USERS={os.environ['EXPECTED_ALLOWED_USERS']}",
    "API_SERVER_PORT=18642",
]
for line in required:
    if line not in lines:
        errors.append(f"missing {line}")
if errors:
    print("FAIL " + "; ".join(errors))
    raise SystemExit(1)
print("OK")
PY`,
      [],
      { artifactName: "phase-4-hermes-discord-env-shape", redactionValues },
    );
    expectExitZero(envProbe, "Hermes Discord .env shape");
    expect(envProbe.stdout.trim()).toBe("OK");

    const fakeGateway = await startHermesFakeDiscordGateway(
      host,
      cleanup,
      env,
      DISCORD_TOKEN,
      redactionValues,
    );
    await applyHermesFakeDiscordPolicy({
      host,
      sandboxName: SANDBOX_NAME,
      api: fakeGateway,
      env,
      redactions: redactionValues,
    });

    const nativeGateway = await runHermesPythonDiscordGatewayProof(
      sandbox,
      fakeGateway.port,
      redactionValues,
    );
    expectExitZero(nativeGateway, "Hermes Python Discord Gateway protocol proof");
    expect(resultText(nativeGateway)).toContain("UPGRADE");
    expect(resultText(nativeGateway)).toContain("HELLO");
    expect(resultText(nativeGateway)).toContain("IDENTIFY_SENT_PLACEHOLDER");
    expect(resultText(nativeGateway)).toContain("READY");
    expect(resultText(nativeGateway)).toContain("HEARTBEAT_ACK");
    expect(resultText(nativeGateway)).not.toContain("IMPORT_DISCORD_FAILED");
    assertDiscordGatewayCapture(fakeGateway.captureFile, DISCORD_TOKEN);

    await assertRawTokenAbsentFromFiles(sandbox, DISCORD_TOKEN, redactionValues);

    const envSurface = await rawTokenSurfaceProbe(
      sandbox,
      DISCORD_TOKEN,
      "env",
      "phase-5-raw-token-env-probe",
      redactionValues,
    );
    expectExitZero(envSurface, "sandbox environment token isolation");
    expect(envSurface.stdout.trim()).toBe("ABSENT");

    const processSurface = await rawTokenSurfaceProbe(
      sandbox,
      DISCORD_TOKEN,
      "process",
      "phase-5-raw-token-process-probe",
      redactionValues,
    );
    expectExitZero(processSurface, "sandbox process token isolation");
    expect(processSurface.stdout.trim()).toBe("ABSENT");

    const filesystemSurface = await rawTokenSurfaceProbe(
      sandbox,
      DISCORD_TOKEN,
      "filesystem",
      "phase-5-raw-token-filesystem-probe",
      redactionValues,
    );
    expectExitZero(filesystemSurface, "sandbox filesystem token isolation");
    expect(filesystemSurface.stdout.trim()).toBe("ABSENT");

    const discordApi = await sandboxNode(
      sandbox,
      SANDBOX_NAME,
      `
import fs from "node:fs";
import https from "node:https";
const env = fs.readFileSync("/sandbox/.hermes/.env", "utf8");
const line = env.split(/\\n/).find((entry) => entry.startsWith("DISCORD_BOT_TOKEN="));
const token = line ? line.slice("DISCORD_BOT_TOKEN=".length) : "";
switch (token ? "present" : "missing") {
  case "missing":
    console.log(JSON.stringify({ error: "missing_token" }));
    process.exit(0);
}
const req = https.request({
  hostname: "discord.com",
  path: "/api/v10/users/@me",
  method: "GET",
  headers: { Authorization: "Bot " + token },
}, (res) => {
  let body = "";
  res.on("data", (d) => { body += d; });
  res.on("end", () => console.log(JSON.stringify({ statusCode: res.statusCode, body: body.slice(0, 200) })));
});
req.on("error", (error) => console.log(JSON.stringify({ error: error.message })));
req.setTimeout(20000, () => { req.destroy(); console.log(JSON.stringify({ error: "timeout" })); });
req.end();
`,
      {},
      {
        artifactName: "phase-6-discord-users-me",
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(discordApi, "Discord REST users/@me probe command");
    const discordApiRows = discordApi.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as { statusCode?: number; error?: string });
    const discordApiResult = discordApiRows.at(-1) ?? {};
    switch (discordApiResult.error ?? "") {
      case "timeout":
        await artifacts.writeJson("phase-6-discord-users-me-skip.json", {
          reason: "Discord API timed out, matching legacy skip behavior",
        });
        break;
      case "":
        expect(
          [200, 401].includes(discordApiResult.statusCode ?? 0),
          `Unexpected Discord users/@me response (got ${discordApiResult.statusCode}): ${discordApi.stdout}`,
        ).toBe(true);
        break;
      default:
        throw new Error(`Discord API call failed: ${discordApiResult.error}`);
    }

    const bridgeResidue = await sandboxEncodedSh(
      sandbox,
      SANDBOX_NAME,
      String.raw`set +e
env_needle="$(printf "%s%s" "NEMOCLAW_DISCORD_" "FACADE_URL")"
name_needle="$(printf "%s%s" "nemoclaw-discord-" "facade")"
proxy_needle="$(printf "%s" "DISCORD_PROXY")"
decode_needle="$(printf "%s%s%s" "nemoclaw-" "decode" "-proxy")"
if env | grep -q "$env_needle"; then echo ENV_FACADE; fi
if env | grep -q "^$proxy_needle="; then echo ENV_DISCORD_PROXY; fi
if grep -Fq "$env_needle" /sandbox/.hermes/.env /sandbox/.hermes/config.yaml /tmp/nemoclaw-proxy-env.sh /tmp/gateway.env 2>/dev/null; then echo FILE_FACADE; fi
if grep -Fq "$proxy_needle" /sandbox/.hermes/.env /sandbox/.hermes/config.yaml /tmp/nemoclaw-proxy-env.sh /tmp/gateway.env 2>/dev/null; then echo FILE_DISCORD_PROXY; fi
if find /tmp -maxdepth 1 -type f \( -name "discord-facade.log" -o -name "nemoclaw-discord-facade*" \) 2>/dev/null | grep -q .; then echo FILE_FACADE; fi
if command -v "$decode_needle" >/dev/null 2>&1; then echo BIN_DECODE_PROXY; fi
current_pid="$$"
for p in /proc/[0-9]*; do
  pid=$(basename "$p")
  [ "$pid" = "$current_pid" ] && continue
  cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true)
  case "$cmd" in *"name_needle="*|*"for p in /proc/"*) continue ;; esac
  case "$cmd" in *"$name_needle"*) echo PROCESS_FACADE ;; esac
  case "$cmd" in *"$decode_needle"*) echo PROCESS_DECODE_PROXY ;; esac
done`,
      [],
      { artifactName: "phase-7-no-local-discord-bridge", redactionValues },
    );
    expectExitZero(bridgeResidue, "no local Discord bridge residue probe");
    expect(bridgeResidue.stdout.trim()).toBe("");

    await bestEffort(() =>
      host.command("docker", ["rm", "-f", fakeGateway.container], {
        artifactName: "phase-8-remove-fake-discord-container-before-rebuild",
        env,
        redactionValues,
        timeoutMs: 60_000,
      }),
    );
    fs.rmSync(fakeGateway.dir, { recursive: true, force: true });
    await bestEffort(() =>
      host.command(
        "bash",
        [
          "-lc",
          "sudo rm -rf .tmp/fake-discord.* 2>/dev/null || rm -rf .tmp/fake-discord.* 2>/dev/null || true",
        ],
        {
          artifactName: "phase-8-remove-fake-discord-scratch-before-rebuild",
          cwd: REPO_ROOT,
          env,
          redactionValues,
          timeoutMs: 60_000,
        },
      ),
    );

    const rebuildEnv = commandEnv();
    delete rebuildEnv.NVIDIA_INFERENCE_API_KEY;
    delete rebuildEnv.NVIDIA_API_KEY;
    delete rebuildEnv.COMPATIBLE_API_KEY;
    const rebuild = await host.command("nemoclaw", [SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "phase-8-rebuild-without-inference-env",
      env: rebuildEnv,
      redactionValues,
      timeoutMs: 45 * 60_000,
    });
    expectExitZero(rebuild, "Hermes rebuild without NVIDIA_INFERENCE_API_KEY");
    expect(resultText(rebuild)).not.toMatch(/provider credential not found/i);

    await (async (): Promise<void> => {
      switch (process.env.NEMOCLAW_E2E_KEEP_SANDBOX) {
        case "1":
          return;
        default:
      }
      const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "phase-9-nemoclaw-destroy",
        env,
        redactionValues,
        timeoutMs: 15 * 60_000,
      });
      expectExitZero(destroy, "destroy Hermes Discord sandbox");
      await bestEffort(() =>
        host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "phase-9-openshell-gateway-destroy",
          env,
          redactionValues,
          timeoutMs: 120_000,
        }),
      );
      const registryProbe = await host.command(
        "bash",
        [
          "-lc",
          `registry="$HOME/.nemoclaw/sandboxes.json"; if [ -f "$registry" ] && grep -Fq ${shellQuote(`"${SANDBOX_NAME}"`)} "$registry"; then echo FOUND; exit 1; else echo ABSENT; fi`,
        ],
        {
          artifactName: "phase-9-registry-removal-probe",
          env: sandboxAccessEnv(),
          redactionValues,
          timeoutMs: 30_000,
        },
      );
      expectExitZero(registryProbe, "sandbox removed from registry");
      expect(registryProbe.stdout.trim()).toBe("ABSENT");
    })();

    await artifacts.writeJson("scenario-result.json", {
      id: "hermes-discord",
      assertions: {
        dockerAndNonInteractivePrereqs: true,
        installHermesDiscord: true,
        providerRegistered: true,
        hermesHealthy: true,
        configSchema: true,
        envPlaceholders: true,
        nativePythonDiscordGatewayRewrite: true,
        rawTokenAbsentFromConfigEnvProcessAndFilesystem: true,
        discordRestBoundaryReachedOrSkippedOnTimeout: true,
        noLocalDiscordBridgeResidue: true,
        rebuildReusedGatewayCredentialWithoutInferenceEnv: true,
        cleanupVerified: process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1",
      },
    });
  },
);
