#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Discord Gateway helpers for messaging E2E scripts.

append_exit_trap_for_fake_discord_gateway() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_discord_gateway() {
  if [ -n "${FAKE_DISCORD_GATEWAY_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_DISCORD_GATEWAY_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_DISCORD_GATEWAY_PID:-}" ]; then
    kill "$FAKE_DISCORD_GATEWAY_PID" 2>/dev/null || true
    wait "$FAKE_DISCORD_GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "${FAKE_DISCORD_GATEWAY_DIR:-}" ]; then
    rm -rf "$FAKE_DISCORD_GATEWAY_DIR" 2>/dev/null || true
  fi
}

start_fake_discord_gateway() {
  local expected_token="$1"
  mkdir -p "$REPO/.tmp"
  FAKE_DISCORD_GATEWAY_DIR="$(mktemp -d "$REPO/.tmp/fake-discord.XXXXXX")"
  FAKE_DISCORD_GATEWAY_PORT_FILE="$FAKE_DISCORD_GATEWAY_DIR/port"
  FAKE_DISCORD_GATEWAY_CAPTURE_FILE="$FAKE_DISCORD_GATEWAY_DIR/capture.jsonl"
  FAKE_DISCORD_GATEWAY_CONTAINER="nemoclaw-fake-discord-$$-$RANDOM"
  FAKE_DISCORD_GATEWAY_HOST="host.docker.internal"
  : >"$FAKE_DISCORD_GATEWAY_CAPTURE_FILE"

  if ! docker run -d --rm \
    --name "$FAKE_DISCORD_GATEWAY_CONTAINER" \
    -p 0:8080 \
    -e FAKE_DISCORD_GATEWAY_PORT=8080 \
    -e FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN="$expected_token" \
    -e FAKE_DISCORD_GATEWAY_PORT_FILE=/tmp/fake-discord/port \
    -e FAKE_DISCORD_GATEWAY_CAPTURE_FILE=/tmp/fake-discord/capture.jsonl \
    -v "$FAKE_DISCORD_GATEWAY_DIR:/tmp/fake-discord" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-discord-gateway.cjs \
    >"$FAKE_DISCORD_GATEWAY_DIR/container.id" 2>"$FAKE_DISCORD_GATEWAY_DIR/server.log"; then
    cat "$FAKE_DISCORD_GATEWAY_DIR/server.log" >&2 || true
    return 1
  fi
  append_exit_trap_for_fake_discord_gateway cleanup_fake_discord_gateway

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_DISCORD_GATEWAY_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_DISCORD_GATEWAY_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        # Exported for callers that source this helper and apply policy/probes after startup.
        export FAKE_DISCORD_GATEWAY_PORT
        FAKE_DISCORD_GATEWAY_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_DISCORD_GATEWAY_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_DISCORD_GATEWAY_CONTAINER" >&2 || true
      cat "$FAKE_DISCORD_GATEWAY_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_DISCORD_GATEWAY_DIR/server.log" >&2 || true
  return 1
}

fake_discord_gateway_allowed_ip_options() {
  printf '%s' 'allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16'
}

apply_fake_discord_gateway_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_DISCORD_GATEWAY_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_discord_gateway_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:websocket:enforce:websocket-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:WEBSOCKET_TEXT:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --binary /usr/local/bin/python3 \
    --binary /usr/bin/python3 \
    --binary /opt/hermes/.venv/bin/python \
    --wait
}

run_fake_discord_gateway_node_client() {
  local port="$1"
  local identify_token="$2"
  local host="${FAKE_DISCORD_GATEWAY_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_DISCORD_GATEWAY_CLIENT_HOST='$host' FAKE_DISCORD_GATEWAY_CLIENT_PORT='$port' FAKE_DISCORD_GATEWAY_IDENTIFY_TOKEN='$identify_token' node - 2>&1" <<'NODE'
const crypto = require("crypto");
const net = require("net");

const host = process.env.FAKE_DISCORD_GATEWAY_CLIENT_HOST || "host.openshell.internal";
const port = Number(process.env.FAKE_DISCORD_GATEWAY_CLIENT_PORT);
const identifyToken = process.env.FAKE_DISCORD_GATEWAY_IDENTIFY_TOKEN;
const proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || "";
const results = [];

function proxyTarget() {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:") return null;
    return {
      host: parsed.hostname,
      port: Number(parsed.port || "80"),
    };
  } catch {
    return null;
  }
}

function finish(message) {
  if (message) results.push(message);
  console.log(results.join("\n"));
  process.exit(0);
}

function encodeClientText(payload) {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, mask, masked]);
}

function encodeClientClose(code) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, body]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + payloadLength) return null;
  return {
    opcode,
    payload: buffer.slice(offset, offset + payloadLength),
    totalLength: offset + payloadLength,
  };
}

const proxy = proxyTarget();
const socket = proxy
  ? net.createConnection({ host: proxy.host, port: proxy.port })
  : net.createConnection({ host, port });
const timer = setTimeout(() => {
  try { socket.destroy(); } catch {}
  finish("TIMEOUT");
}, 20000);

let handshake = Buffer.alloc(0);
let framed = Buffer.alloc(0);
let upgraded = false;
let sawReady = false;

socket.on("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  const requestTarget = proxy
    ? `http://${host}:${port}/gateway?v=10&encoding=json`
    : "/gateway?v=10&encoding=json";
  socket.write([
    `GET ${requestTarget} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n"));
});

socket.on("data", (chunk) => {
  if (!upgraded) {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf("\r\n\r\n");
    if (end === -1) return;
    const statusLine = handshake.slice(0, end).toString("latin1").split("\r\n")[0] || "";
    if (!statusLine.includes("101")) {
      clearTimeout(timer);
      finish(`HTTP_${statusLine}`);
    }
    upgraded = true;
    results.push("UPGRADE");
    framed = Buffer.concat([framed, handshake.slice(end + 4)]);
  } else {
    framed = Buffer.concat([framed, chunk]);
  }

  while (framed.length > 0) {
    const frame = decodeFrame(framed);
    if (!frame) break;
    framed = framed.slice(frame.totalLength);
    if (frame.opcode === 1) {
      const message = JSON.parse(frame.payload.toString("utf8"));
      if (message.op === 10) {
        results.push("HELLO");
        socket.write(encodeClientText(JSON.stringify({
          op: 2,
          d: {
            token: identifyToken,
            intents: 0,
            properties: { os: "linux", browser: "nemoclaw-e2e", device: "nemoclaw-e2e" },
          },
        })));
        results.push(
          identifyToken.includes("openshell:resolve:env:")
            ? "IDENTIFY_SENT_PLACEHOLDER"
            : "IDENTIFY_SENT_NON_PLACEHOLDER",
        );
      } else if (message.op === 0 && message.t === "READY") {
        sawReady = true;
        results.push("READY");
        socket.write(encodeClientText(JSON.stringify({ op: 1, d: message.s ?? null })));
      } else if (message.op === 11) {
        results.push("HEARTBEAT_ACK");
        socket.write(encodeClientClose(1000));
        clearTimeout(timer);
        finish();
      }
    } else if (frame.opcode === 8) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0;
      clearTimeout(timer);
      finish(`CLOSE_${code}`);
    }
  }
});

socket.on("error", (error) => {
  clearTimeout(timer);
  finish(`ERROR ${error.message}`);
});
socket.on("close", () => {
  clearTimeout(timer);
  if (!sawReady) finish("CLOSED");
});
NODE
}

run_fake_discord_gateway_python_client() {
  local port="$1"
  local host="${FAKE_DISCORD_GATEWAY_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_DISCORD_GATEWAY_CLIENT_HOST='$host' FAKE_DISCORD_GATEWAY_CLIENT_PORT='$port' /opt/hermes/.venv/bin/python - 2>&1" <<'PY'
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
    host = os.environ.get("FAKE_DISCORD_GATEWAY_CLIENT_HOST", "host.openshell.internal")
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
PY
}
