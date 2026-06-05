#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helpers for inference-switch E2Es that need a compatible Anthropic
# Messages provider. The mock provider runs on the host; agents still reach it
# only through OpenShell-managed inference.local.

ANTHROPIC_SWITCH_MOCK_PID=""
ANTHROPIC_SWITCH_MOCK_LOG="${ANTHROPIC_SWITCH_MOCK_LOG:-/tmp/nemoclaw-e2e-anthropic-switch-provider.log}"

parse_anthropic_content() {
  python3 -c '
import json, sys
try:
    r = json.load(sys.stdin)
    parts = r.get("content") or []
    text = []
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            text.append(part["text"])
    print(" ".join(text).strip())
except Exception as e:
    print(f"PARSE_ERROR: {e}", file=sys.stderr)
    sys.exit(1)
'
}

start_mock_anthropic_switch_provider() {
  local port="${SWITCH_MOCK_PORT:-18766}"
  local host="${SWITCH_MOCK_HOST:-host.openshell.internal}"
  local health_url="http://127.0.0.1:${port}/health"
  SWITCH_ENDPOINT_URL="${SWITCH_ENDPOINT_URL:-http://${host}:${port}}"
  export SWITCH_ENDPOINT_URL

  python3 - "$port" >"$ANTHROPIC_SWITCH_MOCK_LOG" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

port = int(sys.argv[1])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write((fmt % args) + "\n")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for name, payload in events:
            self.wfile.write(("event: " + name + "\n").encode("utf-8"))
            self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode("utf-8"))
        self.wfile.flush()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True})
            return
        if path in ("/v1/models", "/v1/models/mock-anthropic-model"):
            self._json(200, {"data": [{"id": "mock-anthropic-model"}]})
            return
        self._json(404, {"error": "not found", "path": path})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if path != "/v1/messages":
            self._json(404, {"error": "unexpected path", "path": path})
            return
        model = payload.get("model") or "mock-anthropic-model"
        if payload.get("stream") is True:
            message = {
                "id": "msg_mock",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 0},
            }
            self._sse([
                ("message_start", {"type": "message_start", "message": message}),
                (
                    "content_block_start",
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                ),
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "PONG"}},
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                (
                    "message_delta",
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                        "usage": {"output_tokens": 1},
                    },
                ),
                ("message_stop", {"type": "message_stop"}),
            ])
            return
        self._json(200, {
            "id": "msg_mock",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "PONG"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        })

ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
PY
  ANTHROPIC_SWITCH_MOCK_PID=$!

  local attempt=1
  while [ "$attempt" -le 5 ]; do
    if curl -sf --max-time 2 "$health_url" >/dev/null 2>&1; then
      pass "Mock Anthropic Messages provider is listening on ${SWITCH_ENDPOINT_URL}"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  fail "Mock Anthropic Messages provider did not start; log: ${ANTHROPIC_SWITCH_MOCK_LOG}"
  return 1
}

stop_mock_anthropic_switch_provider() {
  if [ -n "${ANTHROPIC_SWITCH_MOCK_PID:-}" ]; then
    kill "$ANTHROPIC_SWITCH_MOCK_PID" >/dev/null 2>&1 || true
    wait "$ANTHROPIC_SWITCH_MOCK_PID" >/dev/null 2>&1 || true
    ANTHROPIC_SWITCH_MOCK_PID=""
  fi
}

ensure_compatible_anthropic_switch_provider() {
  if [ "${SWITCH_PROVIDER:-}" != "compatible-anthropic-endpoint" ]; then
    return 0
  fi
  if [ "${SWITCH_INFERENCE_API:-}" != "anthropic-messages" ]; then
    return 0
  fi

  if [ "${SWITCH_MOCK_ANTHROPIC:-}" = "1" ]; then
    start_mock_anthropic_switch_provider || return 1
    export COMPATIBLE_ANTHROPIC_API_KEY="${COMPATIBLE_ANTHROPIC_API_KEY:-test-compatible-anthropic-key}"
  fi

  if [ -z "${SWITCH_ENDPOINT_URL:-}" ]; then
    fail "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches"
    return 1
  fi
  if [ -z "${COMPATIBLE_ANTHROPIC_API_KEY:-}" ]; then
    fail "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches"
    return 1
  fi

  if openshell provider get -g nemoclaw compatible-anthropic-endpoint >/dev/null 2>&1; then
    if ! openshell provider update -g nemoclaw compatible-anthropic-endpoint \
      --credential COMPATIBLE_ANTHROPIC_API_KEY \
      --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}" >/dev/null; then
      fail "Failed to update OpenShell provider compatible-anthropic-endpoint"
      return 1
    fi
  else
    if ! openshell provider create -g nemoclaw \
      --name compatible-anthropic-endpoint \
      --type anthropic \
      --credential COMPATIBLE_ANTHROPIC_API_KEY \
      --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}" >/dev/null; then
      fail "Failed to create OpenShell provider compatible-anthropic-endpoint"
      return 1
    fi
  fi
  pass "OpenShell provider compatible-anthropic-endpoint is registered for ${SWITCH_ENDPOINT_URL}"
}
