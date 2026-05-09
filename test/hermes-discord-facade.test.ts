// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const FACADE = path.join(ROOT, "agents", "hermes", "discord-facade.py");
const PRELOAD = path.join(ROOT, "agents", "hermes", "discord-preload", "sitecustomize.py");
const sanitizedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined && !key.startsWith("DISCORD_") && !key.startsWith("TELEGRAM_"),
  ),
) as Record<string, string>;
const hasCryptography =
  spawnSync("python3", ["-c", "import cryptography.hazmat.primitives.asymmetric.ed25519"], {
    env: sanitizedEnv,
    stdio: "ignore",
  }).status === 0;

function runPython(source: string, env: Record<string, string> = {}) {
  return spawnSync("python3", ["-"], {
    input: source,
    encoding: "utf-8",
    env: {
      ...sanitizedEnv,
      ...env,
    },
    timeout: 10_000,
  });
}

function pythonPrelude(): string {
  return `
import asyncio
import importlib.util
import json
import sys
import types

aiohttp = types.ModuleType("aiohttp")

class FakeResponse:
    def __init__(self, *, status=200, body=b"", headers=None):
        self.status = status
        self.body = body
        self.headers = headers or {}

class FakeWeb:
    Response = FakeResponse
    class WebSocketResponse:
        pass
    class Request:
        pass
    @staticmethod
    def json_response(data, status=200, dumps=json.dumps):
        return FakeResponse(status=status, body=dumps(data).encode("utf-8"), headers={"Content-Type": "application/json"})

class FakeClientSession:
    pass

aiohttp.ClientSession = FakeClientSession
aiohttp.WSMsgType = types.SimpleNamespace(TEXT=1)
aiohttp.web = FakeWeb
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location("discord_facade", ${JSON.stringify(FACADE)})
discord_facade = importlib.util.module_from_spec(spec)
sys.modules["discord_facade"] = discord_facade
spec.loader.exec_module(discord_facade)
`;
}

describe("Hermes Discord facade", () => {
  it("accepts only the OpenShell placeholder in local Gateway IDENTIFY frames", () => {
    const result = runPython(`${pythonPrelude()}
class FakeWS:
    def __init__(self):
        self.sent = []
        self.closed = None
    async def send_str(self, value):
        self.sent.append(json.loads(value))
    async def close(self, code=None, message=b""):
        self.closed = (code, message)

async def main():
    facade = discord_facade.DiscordFacade(
        host="127.0.0.1",
        port=3130,
        placeholder_token=discord_facade.DEFAULT_TOKEN_PLACEHOLDER,
        upstream_proxy=None,
        public_base_url=None,
        public_key=None,
    )
    good_ws = FakeWS()
    good_peer = discord_facade.GatewayPeer(ws=good_ws)
    await facade._handle_gateway_payload(good_peer, {"op": 2, "d": {"token": discord_facade.DEFAULT_TOKEN_PLACEHOLDER}})
    assert good_peer.identified is True
    assert good_ws.sent[-1]["t"] == "READY"
    assert good_ws.sent[-1]["d"]["user"]["bot"] is True

    bad_ws = FakeWS()
    bad_peer = discord_facade.GatewayPeer(ws=bad_ws)
    realish = "mfa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
    await facade._handle_gateway_payload(bad_peer, {"op": 2, "d": {"token": realish}})
    assert bad_peer.identified is False
    assert bad_ws.closed[0] == 4004

asyncio.run(main())
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("forwards REST requests with the placeholder Authorization header intact", () => {
    const result = runPython(`${pythonPrelude()}
class ForwardedResponse:
    status = 202
    headers = {"Content-Type": "application/json"}
    async def read(self):
        return b'{"ok":true}'

class ForwardContext:
    async def __aenter__(self):
        return ForwardedResponse()
    async def __aexit__(self, exc_type, exc, tb):
        return False

class FakeSession:
    def __init__(self):
        self.calls = []
    def request(self, method, target, headers, data, proxy, allow_redirects):
        self.calls.append({
            "method": method,
            "target": target,
            "headers": headers,
            "data": data,
            "proxy": proxy,
            "allow_redirects": allow_redirects,
        })
        return ForwardContext()

class FakeRequest:
    method = "POST"
    path = "/api/v10/channels/123/messages"
    path_qs = "/api/v10/channels/123/messages"
    query_string = ""
    headers = {
        "Host": "127.0.0.1:3130",
        "Authorization": "Bot openshell:resolve:env:DISCORD_BOT_TOKEN",
        "Content-Type": "application/json",
        "Content-Length": "2",
    }
    async def read(self):
        return b"{}"

async def main():
    session = FakeSession()
    facade = discord_facade.DiscordFacade(
        host="127.0.0.1",
        port=3130,
        placeholder_token=discord_facade.DEFAULT_TOKEN_PLACEHOLDER,
        upstream_proxy="http://127.0.0.1:3129",
        public_base_url=None,
        public_key=None,
    )
    facade._session = session
    response = await facade._forward_rest(FakeRequest())
    assert response.status == 202
    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["target"] == "https://discord.com/api/v10/channels/123/messages"
    assert call["headers"]["Authorization"] == "Bot openshell:resolve:env:DISCORD_BOT_TOKEN"
    assert "Content-Length" not in call["headers"]
    assert call["proxy"] == "http://127.0.0.1:3129"

asyncio.run(main())
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("synthesizes message, reaction, and thread Gateway events from REST polling", () => {
    const result = runPython(`${pythonPrelude()}
from urllib.parse import urlparse

state = {
    "channels": [{"id": "200", "type": 0, "guild_id": "100"}],
    "messages": [{
        "id": "300",
        "channel_id": "200",
        "guild_id": "100",
        "content": "hello",
        "author": {"id": "400", "username": "user", "discriminator": "0000"},
        "timestamp": "2026-05-07T00:00:00.000000+00:00",
        "reactions": [{"count": 1, "emoji": {"name": "thumbsup"}}],
    }],
    "threads": [{"id": "500", "guild_id": "100", "parent_id": "200", "type": 11, "name": "thread"}],
}

class PollResponse:
    def __init__(self, payload):
        self.status = 200
        self.headers = {"Content-Type": "application/json"}
        self.payload = payload
    async def read(self):
        return json.dumps(self.payload).encode("utf-8")

class PollContext:
    def __init__(self, payload):
        self.payload = payload
    async def __aenter__(self):
        return PollResponse(self.payload)
    async def __aexit__(self, exc_type, exc, tb):
        return False

class PollSession:
    def request(self, method, target, headers, proxy, allow_redirects):
        path = urlparse(target).path
        assert headers["Authorization"] == "Bot openshell:resolve:env:DISCORD_BOT_TOKEN"
        if path == "/api/v10/guilds/100/channels":
            return PollContext(state["channels"])
        if path == "/api/v10/channels/200/messages":
            return PollContext(state["messages"])
        if path == "/api/v10/guilds/100/threads/active":
            return PollContext({"threads": state["threads"]})
        raise AssertionError(path)

async def main():
    facade = discord_facade.DiscordFacade(
        host="127.0.0.1",
        port=3130,
        placeholder_token=discord_facade.DEFAULT_TOKEN_PLACEHOLDER,
        upstream_proxy="http://127.0.0.1:3129",
        public_base_url=None,
        public_key=None,
    )
    facade._session = PollSession()
    facade._poll_guild_ids = {"100"}
    events = []
    async def record(event_type, data):
        events.append((event_type, data))
    facade.dispatch_to_all = record

    await facade._poll_once()
    assert [event[0] for event in events] == ["MESSAGE_CREATE", "THREAD_CREATE"]

    events.clear()
    state["messages"][0]["content"] = "hello edited"
    state["messages"][0]["edited_timestamp"] = "2026-05-07T00:01:00.000000+00:00"
    state["messages"][0]["reactions"][0]["count"] = 2
    await facade._poll_once()
    event_names = [event[0] for event in events]
    assert "MESSAGE_UPDATE" in event_names
    assert "MESSAGE_REACTION_ADD" in event_names

    events.clear()
    state["messages"] = [
        {
            "id": str(1000 + index),
            "channel_id": "200",
            "guild_id": "100",
            "content": f"page item {index}",
            "author": {"id": "400", "username": "user", "discriminator": "0000"},
            "timestamp": "2026-05-07T00:02:00.000000+00:00",
            "reactions": [],
        }
        for index in range(25)
    ]
    await facade._poll_once()
    event_names = [event[0] for event in events]
    assert "MESSAGE_DELETE" not in event_names

    events.clear()
    state["messages"] = []
    state["threads"] = []
    await facade._poll_once()
    event_names = [event[0] for event in events]
    assert "MESSAGE_DELETE" in event_names
    assert "THREAD_DELETE" in event_names

asyncio.run(main())
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  (hasCryptography ? it : it.skip)(
    "validates Discord interaction signatures and keeps real interaction tokens out of Gateway payloads",
    () => {
    const result = runPython(`${pythonPrelude()}
import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

private_key = Ed25519PrivateKey.generate()
public_key = private_key.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
).hex()
timestamp = "1710000000"
body = b'{"type":2,"token":"real-interaction-token","id":"42"}'
signature = private_key.sign(timestamp.encode("utf-8") + body).hex()

class FakeRequest:
    headers = {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
    }

facade = discord_facade.DiscordFacade(
    host="127.0.0.1",
    port=3130,
    placeholder_token=discord_facade.DEFAULT_TOKEN_PLACEHOLDER,
    upstream_proxy=None,
    public_base_url=None,
    public_key=public_key,
)
assert facade._verify_signature(FakeRequest(), body) is True
FakeRequest.headers["X-Signature-Ed25519"] = "00" * 64
assert facade._verify_signature(FakeRequest(), body) is False

localized = facade._localize_interaction_token(json.loads(body))
assert localized["token"].startswith("nemoclaw-local-")
assert "real-interaction-token" not in json.dumps(localized)
assert facade._interaction_tokens[localized["token"]][0] == "real-interaction-token"
facade._interaction_tokens["expired-token"] = ("stale", 0.0)
facade._prune_interaction_tokens()
assert "expired-token" not in facade._interaction_tokens
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    },
  );

  it("maps localized interaction callback tokens back to Discord before forwarding", () => {
    const result = runPython(`${pythonPrelude()}
import asyncio

class ForwardResponse:
    status = 204
    headers = {"Content-Type": "application/json"}
    async def read(self):
        return b""

class ForwardContext:
    async def __aenter__(self):
        return ForwardResponse()
    async def __aexit__(self, exc_type, exc, tb):
        return False

class ForwardSession:
    def __init__(self):
        self.calls = []
    def request(self, method, target, headers, data, proxy, allow_redirects):
        self.calls.append({
            "method": method,
            "target": target,
            "headers": headers,
            "data": data,
            "proxy": proxy,
            "allow_redirects": allow_redirects,
        })
        return ForwardContext()

class FakeRequest:
    method = "POST"
    path = "/api/v10/interactions/42/nemoclaw-local-token/callback"
    path_qs = path
    query_string = ""
    headers = {"Authorization": "Bot placeholder", "Content-Type": "application/json"}
    async def read(self):
        return b'{"type":4,"data":{"content":"done"}}'

async def main():
    facade = discord_facade.DiscordFacade(
        host="127.0.0.1",
        port=3130,
        placeholder_token=discord_facade.DEFAULT_TOKEN_PLACEHOLDER,
        upstream_proxy="http://127.0.0.1:3129",
        public_base_url=None,
        public_key=None,
    )
    session = ForwardSession()
    facade._session = session
    facade._store_interaction_token("nemoclaw-local-token", "real-interaction-token")
    response = await facade._handle_interaction_callback(FakeRequest(), "42", "nemoclaw-local-token")
    assert response.status == 204
    assert len(session.calls) == 1
    assert session.calls[0]["target"] == "https://discord.com/api/v10/interactions/42/real-interaction-token/callback"
    assert session.calls[0]["data"] == b'{"type":4,"data":{"content":"done"}}'
    assert session.calls[0]["proxy"] == "http://127.0.0.1:3129"

asyncio.run(main())
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

describe("Hermes Discord preload", () => {
  it("rewrites discord.py REST and Gateway aiohttp calls to the local facade", () => {
    const result = runPython(`
import asyncio
import importlib.util
import os
import sys
import types

aiohttp = types.ModuleType("aiohttp")

class ClientSession:
    async def _request(self, method, url, **kwargs):
        return {"method": method, "url": str(url), "kwargs": kwargs}
    def ws_connect(self, url, **kwargs):
        return {"url": str(url), "kwargs": kwargs}

aiohttp.ClientSession = ClientSession
sys.modules["aiohttp"] = aiohttp
os.environ["NEMOCLAW_DISCORD_FACADE_URL"] = "http://127.0.0.1:3130"

spec = importlib.util.spec_from_file_location("sitecustomize", ${JSON.stringify(PRELOAD)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

async def main():
    session = aiohttp.ClientSession()
    rest = await session._request("GET", "https://discord.com/api/v10/users/@me?x=1", proxy="http://proxy")
    assert rest["url"] == "http://127.0.0.1:3130/api/v10/users/@me?x=1"
    assert "proxy" not in rest["kwargs"]
    ws = session.ws_connect("wss://gateway.discord.gg/?encoding=json", proxy="http://proxy")
    assert ws["url"] == "ws://127.0.0.1:3130/gateway?encoding=json&v=10"
    assert "proxy" not in ws["kwargs"]

asyncio.run(main())
`);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
