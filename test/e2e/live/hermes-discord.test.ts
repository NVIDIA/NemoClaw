// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { HERMES_DISCORD_TEST_TIMEOUT_MS } from "../../../tools/e2e/hermes-timeout-contract.mts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { cleanupWhenOpenShellAvailable } from "../fixtures/cleanup-resources.ts";
import type { HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import { sandboxAccessEnv, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { applyFixtureProviderPolicyEndpoint } from "../fixtures/gateway-providers.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { hermesDiscordHttpProxyWebSocketUrl } from "./hermes-discord-proxy.ts";
import {
  assertDiscordGatewayCapture,
  type FakeDockerApi,
  startFakeDockerApi,
} from "./messaging-providers-helpers.ts";
import {
  runSecondaryCleanup as bestEffortLifecycleCleanup,
  expectExitZero,
  phase6Env,
  requirePhase6RuntimeProvider,
  resultText,
  sandboxSh,
  sandboxShWithArgs,
  shellQuote,
  trackPreinstallSandboxCleanup,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-discord";
validateSandboxName(SANDBOX_NAME);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "test-fake-discord-token-hermes-e2e";
const DISCORD_SERVER_IDS = process.env.DISCORD_SERVER_IDS ?? "1491590992753590594";
const DISCORD_ALLOWED_IDS = process.env.DISCORD_ALLOWED_IDS ?? "1005536447329222676";
const DISCORD_REQUIRE_MENTION = process.env.DISCORD_REQUIRE_MENTION ?? "0";
const HERMES_HEALTH_URL = "http://localhost:8642/health";
const FAKE_DISCORD_HOST = "host.openshell.internal";
const HERMES_DISCORD_HTTP_PROXY_GATEWAY_TEMPLATE = hermesDiscordHttpProxyWebSocketUrl(
  "{host}",
  "{port}",
);

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
      NEMOCLAW_MODEL: process.env.NEMOCLAW_MODEL ?? "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL:
        process.env.NEMOCLAW_COMPAT_MODEL ??
        process.env.NEMOCLAW_MODEL ??
        "nvidia/nvidia/nemotron-3-ultra",
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

async function precleanHermesDiscord(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
  prefix: string,
): Promise<void> {
  await bestEffortLifecycleCleanup(() =>
    host.command("nemoclaw", [sandboxName, "destroy", "--yes"], {
      artifactName: `${prefix}-nemoclaw-destroy`,
      env,
      redactionValues,
      timeoutMs: 15 * 60_000,
    }),
  );
  await bestEffortLifecycleCleanup(() =>
    host.command(host.openshellCommandPath, ["sandbox", "delete", sandboxName], {
      artifactName: `${prefix}-openshell-sandbox-delete`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    }),
  );
  await bestEffortLifecycleCleanup(() =>
    host.command(host.openshellCommandPath, ["gateway", "destroy", "-g", "nemoclaw"], {
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
  return startFakeDockerApi(host, cleanup.trackDisposable.bind(cleanup), {
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

const HERMES_DISCORD_PYTHON_GATEWAY_PROOF = String.raw`
import asyncio
import inspect
import os
import re

try:
    import aiohttp
    import discord
    from discord.http import DiscordClientWebSocketResponse
    from yarl import URL
except Exception as exc:
    print(f"IMPORT_DISCORD_FAILED {type(exc).__name__}: {exc}")
    raise SystemExit(1)


def read_env_token():
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if not re.fullmatch(r"openshell:resolve:env:v[1-9][0-9]*_DISCORD_BOT_TOKEN", token):
        raise RuntimeError("DISCORD_BOT_TOKEN is not the revision-scoped process placeholder")
    return token


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


results = []


async def main():
    port = int(os.environ["FAKE_DISCORD_GATEWAY_CLIENT_PORT"])
    host = os.environ.get("FAKE_DISCORD_GATEWAY_CLIENT_HOST", "host.openshell.internal")
    token = read_env_token()
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
        # aiohttp preserves the target scheme in the absolute-form request it
        # sends to an HTTP proxy. OpenShell accepts WebSocket upgrades through
        # that proxy as HTTP requests with Upgrade headers, matching the raw
        # Node proof below; a ws:// absolute-form target is rejected with 400
        # before it reaches the fake gateway.
        kwargs = {"gateway": URL(f"${HERMES_DISCORD_HTTP_PROXY_GATEWAY_TEMPLATE}")}
        params = inspect.signature(from_client).parameters
        if "initial" in params:
            # A fresh proof must identify immediately. discord.py deliberately
            # sleeps before a non-initial IDENTIFY, which leaves only heartbeat
            # traffic on this short-lived credential-rewrite connection.
            kwargs["initial"] = True
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
    if results:
        print("\n".join(results))
    print(f"ERROR {type(exc).__name__}: {exc}")
    raise SystemExit(1)
`;

async function runHermesPythonDiscordGatewayProof(
  sandbox: SandboxClient,
  port: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  return sandboxShWithArgs(
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

async function runHermesNodeDiscordDenial(
  sandbox: SandboxClient,
  port: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  return sandboxShWithArgs(
    sandbox,
    SANDBOX_NAME,
    String.raw`/usr/local/bin/node <<'NODE'
const http = require("node:http");
const request = http.request({
  host: "${FAKE_DISCORD_HOST}",
  port: ${port},
  path: "/gateway",
  headers: {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Key": Buffer.from("nemoclaw-denial").toString("base64"),
    "Sec-WebSocket-Version": "13",
  },
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    console.log("response " + response.statusCode + " " + body.slice(0, 200));
  });
});
request.on("upgrade", () => {
  console.log("unexpected websocket upgrade");
  request.destroy();
});
request.setTimeout(20000, () => request.destroy(new Error("timeout")));
request.on("error", (error) => {
  console.log("error " + error.message);
});
request.end();
NODE`,
    [],
    { artifactName: "hermes-node-discord-policy-denial", redactionValues, timeoutMs: 30_000 },
  );
}

async function runHermesNodeDiscordRestDenial(
  sandbox: SandboxClient,
  port: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  return sandboxShWithArgs(
    sandbox,
    SANDBOX_NAME,
    String.raw`FAKE_DISCORD_REST_PORT=${port} /usr/local/bin/node <<'NODE'
const http = require("node:http");
const token = process.env.DISCORD_BOT_TOKEN ?? "";
console.log(
  "TOKEN_PLACEHOLDER " +
    /^openshell:resolve:env:v[1-9][0-9]*_DISCORD_BOT_TOKEN$/.test(token),
);
const request = http.request({
  host: "${FAKE_DISCORD_HOST}",
  port: Number(process.env.FAKE_DISCORD_REST_PORT),
  path: "/api/v10/users/@me",
  method: "GET",
  headers: { Authorization: "Bot " + token },
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    console.log("response " + response.statusCode + " " + body.slice(0, 200));
  });
});
request.setTimeout(20000, () => request.destroy(new Error("timeout")));
request.on("error", (error) => {
  console.log("error " + error.message);
});
request.end();
NODE`,
    [],
    { artifactName: "hermes-node-discord-rest-policy-denial", redactionValues, timeoutMs: 30_000 },
  );
}

function readDiscordRestRequests(captureFile: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === "request");
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
        ? buildProcessTokenProbe(token)
        : `token="$(printf %s ${shellQuote(tokenB64)} | base64 -d)"\nhit="$(grep -rFlm1 -F "$token" /sandbox /home /etc /tmp /var 2>/dev/null | head -1 || true)"\nif [ -n "$hit" ]; then printf 'FOUND_TOKEN %s\\n' "$hit"; else echo ABSENT; fi`;
  return sandboxShWithArgs(sandbox, SANDBOX_NAME, script, [], {
    artifactName,
    redactionValues,
    timeoutMs: surface === "filesystem" ? 120_000 : 60_000,
  });
}

test(
  "hermes-discord: Hermes Discord schema, credential isolation, and native gateway rewrite",
  {
    timeout: HERMES_DISCORD_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean Hermes Discord runner",
        "install Hermes Discord sandbox",
        "validate Discord provider and Hermes health",
        "validate Discord config and placeholders",
        "exercise native Discord gateway rewrite",
        "verify Discord token isolation and REST boundary",
        "finalize Hermes Discord resources",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = commandEnv(apiKey);
    const redactionValues = redactions(apiKey);

    await artifacts.target.declare({
      id: "hermes-discord",
      boundary:
        "install.sh --non-interactive Hermes sandbox + Discord config + OpenShell provider rewrite + sandbox leak probes",
      sandboxName: SANDBOX_NAME,
      discordServerIds: DISCORD_SERVER_IDS,
      discordAllowedIds: DISCORD_ALLOWED_IDS,
      discordRequireMention: DISCORD_REQUIRE_MENTION,
    });

    const gatewayCleanupOptions = {
      artifactName: "cleanup-hermes-discord-openshell-gateway-destroy",
      env,
      redactionValues,
      timeoutMs: 120_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-hermes-discord-probe-openshell-gateway",
              env,
              redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    trackPreinstallSandboxCleanup(
      cleanup,
      host,
      sandbox,
      SANDBOX_NAME,
      env,
      redactionValues,
      "cleanup-hermes-discord",
    );

    await precleanHermesDiscord(
      host,
      SANDBOX_NAME,
      env,
      redactionValues,
      "preclean-hermes-discord",
    );

    await requirePhase6RuntimeProvider(runtimeProvider, "Hermes Discord");

    progress.phase("install Hermes Discord sandbox");
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
      [
        "-lc",
        'command -v nemoclaw && command -v "$1" && "$1" --version',
        "cli-probe-hermes-discord",
        host.openshellCommandPath,
      ],
      {
        artifactName: "phase-1-cli-probe",
        env,
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(cliProbe, "nemoclaw and openshell installed");

    progress.phase("validate Discord provider and Hermes health");
    const list = await host.command("nemoclaw", ["list"], {
      artifactName: "phase-2-nemoclaw-list",
      env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(list, "nemoclaw list");
    expect(resultText(list)).toContain(SANDBOX_NAME);

    const provider = await host.command(
      host.openshellCommandPath,
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
    expect(health?.exitCode, health ? resultText(health) : "missing health result").toBe(0);
    expect(resultText(health!)).toMatch(/"ok"/i);

    progress.phase("validate Discord config and placeholders");
    const expectedRequireMention = DISCORD_REQUIRE_MENTION === "0" ? "false" : "true";
    const configProbe = await sandboxShWithArgs(
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

    const envProbe = await sandboxShWithArgs(
      sandbox,
      SANDBOX_NAME,
      `EXPECTED_ALLOWED_USERS=${shellQuote(normalizedCsv(DISCORD_ALLOWED_IDS))} EXPECTED_GUILD_IDS=${shellQuote(normalizedCsv(DISCORD_SERVER_IDS))} python3 - <<'PY'
import os
from pathlib import Path
text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
lines = text.splitlines()
errors = []
required = [
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

    progress.phase("exercise native Discord gateway rewrite");
    const fakeGateway = await startHermesFakeDiscordGateway(
      host,
      cleanup,
      env,
      DISCORD_TOKEN,
      redactionValues,
    );
    await applyFixtureProviderPolicyEndpoint(host, SANDBOX_NAME, {
      endpoint: fakeGateway,
      protocol: "websocket",
      rewrite: "websocket-credential-rewrite",
      providerName: `${SANDBOX_NAME}-discord-bridge`,
      env,
      redactionValues,
      artifactName: "apply-hermes-fake-discord-gateway-policy",
      allowedBinaries: [
        "/opt/hermes/.venv/bin/python3",
        "/opt/hermes/.venv/bin/python",
        "/usr/bin/python3",
        "/usr/bin/python3.13",
      ],
    });

    const deniedNodeGateway = await runHermesNodeDiscordDenial(
      sandbox,
      fakeGateway.port,
      redactionValues,
    );
    expect(resultText(deniedNodeGateway)).toMatch(
      /response 403|policy[_ ]denied|not allowed by any policy/i,
    );

    const nativeGateway = await runHermesPythonDiscordGatewayProof(
      sandbox,
      fakeGateway.port,
      redactionValues,
    );
    expectExitZero(nativeGateway, "Hermes Python Discord Gateway protocol proof");
    assertDiscordGatewayCapture(fakeGateway.captureFile, DISCORD_TOKEN);

    progress.phase("verify Discord token isolation and REST boundary");
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

    const fakeRest = await startFakeDockerApi(host, cleanup.trackDisposable.bind(cleanup), {
      kind: "discord-message",
      imageScript: "fake-discord-message-api.mts",
      nodeArgs: ["--experimental-strip-types"],
      containerPrefix: "nemoclaw-fake-discord-rest-hermes",
      portEnv: "FAKE_DISCORD_MESSAGE_API_PORT",
      captureFileEnv: "FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE",
      expectedEnv: { FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN: DISCORD_TOKEN },
      env,
      redactionValues,
    });
    await applyFixtureProviderPolicyEndpoint(host, SANDBOX_NAME, {
      endpoint: fakeRest,
      protocol: "rest",
      rewrite: "request-body-credential-rewrite",
      providerName: `${SANDBOX_NAME}-discord-bridge`,
      env,
      redactionValues,
      artifactName: "apply-hermes-fake-discord-rest-policy",
      allowedBinaries: [
        "/opt/hermes/.venv/bin/python3",
        "/opt/hermes/.venv/bin/python",
        "/usr/bin/python3",
        "/usr/bin/python3.13",
      ],
    });

    const deniedNodeRest = await runHermesNodeDiscordRestDenial(
      sandbox,
      fakeRest.port,
      redactionValues,
    );
    expect(resultText(deniedNodeRest)).toMatch(
      /(?=[\s\S]*TOKEN_PLACEHOLDER true)(?=[\s\S]*(?:response 403|policy[_ ]denied|not allowed by any policy))/iu,
    );
    expect(
      readDiscordRestRequests(fakeRest.captureFile),
      "denied Node REST request changed the fake Discord capture",
    ).toEqual([]);

    const discordApi = await sandboxShWithArgs(
      sandbox,
      SANDBOX_NAME,
      `FAKE_DISCORD_REST_PORT=${shellQuote(fakeRest.port)} /opt/hermes/.venv/bin/python - <<'PY'
import os
import re
import urllib.request

token = os.environ.get("DISCORD_BOT_TOKEN", "")
if not re.fullmatch(r"openshell:resolve:env:v[1-9][0-9]*_DISCORD_BOT_TOKEN", token):
    raise SystemExit("invalid Discord token placeholder")
request = urllib.request.Request(
    f"http://${FAKE_DISCORD_HOST}:{os.environ['FAKE_DISCORD_REST_PORT']}/api/v10/users/@me",
    headers={"Authorization": f"Bot {token}"},
    method="GET",
)
with urllib.request.urlopen(request, timeout=20) as response:
    if response.status != 200:
        raise SystemExit(f"unexpected status {response.status}")
PY`,
      [],
      {
        artifactName: "phase-6-discord-users-me",
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(discordApi, "Hermes Python Discord REST users/@me rewrite proof");

    const bridgeResidue = await sandboxShWithArgs(
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
  cmd=$( { tr "\000" " " < "$p/cmdline"; } 2>/dev/null || true)
  case "$cmd" in *"name_needle="*|*"for p in /proc/"*) continue ;; esac
  case "$cmd" in *"$name_needle"*) echo PROCESS_FACADE ;; esac
  case "$cmd" in *"$decode_needle"*) echo PROCESS_DECODE_PROXY ;; esac
done`,
      [],
      { artifactName: "phase-7-no-local-discord-bridge", redactionValues },
    );
    expectExitZero(bridgeResidue, "no local Discord bridge residue probe");
    expect(resultText(bridgeResidue).trim()).toBe("");

    progress.phase("finalize Hermes Discord resources");
    await (async (): Promise<void> => {
      switch (process.env.NEMOCLAW_E2E_KEEP_SANDBOX) {
        case "1":
          return;
        default:
      }
      const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "phase-8-nemoclaw-destroy",
        env,
        redactionValues,
        timeoutMs: 15 * 60_000,
      });
      expectExitZero(destroy, "destroy Hermes Discord sandbox");
      await bestEffortLifecycleCleanup(() =>
        host.command(host.openshellCommandPath, ["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "phase-8-openshell-gateway-destroy",
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
          artifactName: "phase-8-registry-removal-probe",
          env: sandboxAccessEnv(),
          redactionValues,
          timeoutMs: 30_000,
        },
      );
      expectExitZero(registryProbe, "sandbox removed from registry");
    })();

    await artifacts.target.complete({
      id: "hermes-discord",
      assertions: {
        dockerAndNonInteractivePrereqs: true,
        installHermesDiscord: true,
        providerRegistered: true,
        hermesHealthy: true,
        configSchema: true,
        envPlaceholders: true,
        nodeDiscordGatewayDenied: true,
        nativePythonDiscordGatewayRewrite: true,
        rawTokenAbsentFromConfigEnvProcessAndFilesystem: true,
        nativePythonDiscordRestRewrite: true,
        nodeDiscordRestDeniedWithoutCapture: true,
        noLocalDiscordBridgeResidue: true,
        cleanupVerified: process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1",
      },
    });
  },
);
