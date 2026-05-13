#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Slack REST helpers for messaging E2E scripts.

append_exit_trap_for_fake_slack_api() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_slack_api() {
  if [ -n "${FAKE_SLACK_API_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_SLACK_API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_SLACK_API_PID:-}" ]; then
    kill "$FAKE_SLACK_API_PID" 2>/dev/null || true
    wait "$FAKE_SLACK_API_PID" 2>/dev/null || true
  fi
  if [ -n "${FAKE_SLACK_API_DIR:-}" ]; then
    rm -rf "$FAKE_SLACK_API_DIR" 2>/dev/null || true
  fi
}

start_fake_slack_api() {
  local bot_token="$1"
  local app_token="$2"
  mkdir -p "$REPO/.tmp"
  FAKE_SLACK_API_DIR="$(mktemp -d "$REPO/.tmp/fake-slack.XXXXXX")"
  FAKE_SLACK_API_PORT_FILE="$FAKE_SLACK_API_DIR/port"
  FAKE_SLACK_API_CAPTURE_FILE="$FAKE_SLACK_API_DIR/capture.jsonl"
  FAKE_SLACK_API_CONTAINER="nemoclaw-fake-slack-$$-$RANDOM"
  FAKE_SLACK_API_HOST="host.docker.internal"
  : >"$FAKE_SLACK_API_CAPTURE_FILE"

  if ! docker run -d --rm \
    --name "$FAKE_SLACK_API_CONTAINER" \
    -p 0:8080 \
    -e FAKE_SLACK_API_PORT=8080 \
    -e FAKE_SLACK_API_EXPECTED_BOT_TOKEN="$bot_token" \
    -e FAKE_SLACK_API_EXPECTED_APP_TOKEN="$app_token" \
    -e FAKE_SLACK_API_PORT_FILE=/tmp/fake-slack/port \
    -e FAKE_SLACK_API_CAPTURE_FILE=/tmp/fake-slack/capture.jsonl \
    -v "$FAKE_SLACK_API_DIR:/tmp/fake-slack" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-slack-api.cjs \
    >"$FAKE_SLACK_API_DIR/container.id" 2>"$FAKE_SLACK_API_DIR/server.log"; then
    cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
    return 1
  fi
  append_exit_trap_for_fake_slack_api cleanup_fake_slack_api

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_SLACK_API_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_SLACK_API_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        # Exported for callers that source this helper and apply policy/probes after startup.
        export FAKE_SLACK_API_PORT
        FAKE_SLACK_API_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_SLACK_API_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_SLACK_API_CONTAINER" >&2 || true
      cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
  return 1
}

fake_slack_api_allowed_ip_options() {
  printf '%s' 'allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16'
}

apply_fake_slack_api_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_slack_api_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:rest:enforce:request-body-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:POST:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --wait
}

run_fake_slack_api_node_request() {
  local port="$1"
  local path="$2"
  local authorization="$3"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_SLACK_API_HOST='$host' FAKE_SLACK_API_PORT='$port' FAKE_SLACK_API_PATH='$path' FAKE_SLACK_API_AUTH='$authorization' node - 2>&1" <<'NODE'
const http = require("http");

const authorization = process.env.FAKE_SLACK_API_AUTH || "";
const token = authorization.replace(/^Bearer\s+/, "");
const data = `token=${encodeURIComponent(token)}`;
const options = {
  hostname: process.env.FAKE_SLACK_API_HOST || "host.openshell.internal",
  port: Number(process.env.FAKE_SLACK_API_PORT),
  path: process.env.FAKE_SLACK_API_PATH,
  method: "POST",
  headers: {
    Authorization: authorization,
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": data.length,
  },
};

const req = http.request(options, (res) => {
  let body = "";
  res.on("data", (d) => {
    body += d;
  });
  res.on("end", () => {
    console.log(`${res.statusCode} ${body.slice(0, 300)}`);
  });
});

req.on("error", (error) => {
  console.log(`ERROR: ${error.message}`);
});
req.setTimeout(30000, () => {
  req.destroy();
  console.log("TIMEOUT");
});
req.write(data);
req.end();
NODE
}
