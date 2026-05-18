#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Discord REST helpers for policy/binary-whitelist E2E checks.

append_exit_trap_for_fake_discord_rest_api() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_discord_rest_api() {
  if [ -n "${FAKE_DISCORD_REST_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_DISCORD_REST_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_DISCORD_REST_DIR:-}" ]; then
    rm -rf "$FAKE_DISCORD_REST_DIR" 2>/dev/null || true
  fi
}

start_fake_discord_rest_api() {
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required for fake Discord REST TLS cert generation" >&2
    return 1
  fi

  mkdir -p "$REPO/.tmp"
  FAKE_DISCORD_REST_DIR="$(mktemp -d "$REPO/.tmp/fake-discord-rest.XXXXXX")"
  FAKE_DISCORD_REST_PORT_FILE="$FAKE_DISCORD_REST_DIR/port"
  FAKE_DISCORD_REST_CAPTURE_FILE="$FAKE_DISCORD_REST_DIR/capture.jsonl"
  FAKE_DISCORD_REST_KEY_PATH="$FAKE_DISCORD_REST_DIR/key.pem"
  FAKE_DISCORD_REST_CERT_PATH="$FAKE_DISCORD_REST_DIR/cert.pem"
  FAKE_DISCORD_REST_CONTAINER="nemoclaw-fake-discord-rest-$$-$RANDOM"
  FAKE_DISCORD_REST_HOST="host.docker.internal"
  : >"$FAKE_DISCORD_REST_CAPTURE_FILE"
  append_exit_trap_for_fake_discord_rest_api cleanup_fake_discord_rest_api

  if ! openssl req -x509 -newkey rsa:2048 \
    -keyout "$FAKE_DISCORD_REST_KEY_PATH" \
    -out "$FAKE_DISCORD_REST_CERT_PATH" \
    -days 7 \
    -nodes \
    -subj "/CN=host.docker.internal" \
    -addext "subjectAltName=DNS:host.docker.internal,DNS:host.openshell.internal" \
    >/dev/null 2>&1; then
    echo "failed to generate fake Discord REST TLS certificate" >&2
    return 1
  fi

  if ! docker run -d --rm \
    --name "$FAKE_DISCORD_REST_CONTAINER" \
    -p 0:8443 \
    -e FAKE_DISCORD_REST_PORT=8443 \
    -e FAKE_DISCORD_REST_KEY_PATH=/tmp/fake-discord-rest/key.pem \
    -e FAKE_DISCORD_REST_CERT_PATH=/tmp/fake-discord-rest/cert.pem \
    -e FAKE_DISCORD_REST_PORT_FILE=/tmp/fake-discord-rest/port \
    -e FAKE_DISCORD_REST_CAPTURE_FILE=/tmp/fake-discord-rest/capture.jsonl \
    -v "$FAKE_DISCORD_REST_DIR:/tmp/fake-discord-rest" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-discord-rest-api.cjs \
    >"$FAKE_DISCORD_REST_DIR/container.id" 2>"$FAKE_DISCORD_REST_DIR/server.log"; then
    cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
    return 1
  fi

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_DISCORD_REST_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_DISCORD_REST_CONTAINER" 8443/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        export FAKE_DISCORD_REST_PORT
        FAKE_DISCORD_REST_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_DISCORD_REST_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_DISCORD_REST_CONTAINER" >&2 || true
      cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
  return 1
}

apply_fake_discord_rest_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  local preset_file
  preset_file="$FAKE_DISCORD_REST_DIR/policy.yaml"

  cat >"$preset_file" <<EOF_POLICY
preset:
  name: fake-discord-rest
  description: "Hermetic Discord-shaped HTTPS REST endpoint for binary whitelist E2E"

network_policies:
  fake_discord_rest:
    name: fake_discord_rest
    endpoints:
      # L4 TLS pass-through keeps the proof focused on CONNECT-time binary
      # authorization: Node is allowed to tunnel to the fake HTTPS REST
      # server, while curl must be denied before any upstream request arrives.
      - host: $host
        port: $port
        access: full
        tls: skip
        allowed_ips:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
EOF_POLICY

  NEMOCLAW_NON_INTERACTIVE=1 nemoclaw "$sandbox_name" policy-add --from-file "$preset_file" --yes >/tmp/nemoclaw-fake-discord-rest-policy.log 2>&1 || {
    cat /tmp/nemoclaw-fake-discord-rest-policy.log >&2 || true
    return 1
  }
}

run_fake_discord_rest_node_request() {
  local port="$1"
  local path="$2"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_DISCORD_REST_HOST='$host' FAKE_DISCORD_REST_PORT='$port' FAKE_DISCORD_REST_PATH='$path' node - 2>&1" <<'NODE'
const https = require("https");

const options = {
  hostname: process.env.FAKE_DISCORD_REST_HOST || "host.openshell.internal",
  port: Number(process.env.FAKE_DISCORD_REST_PORT),
  path: process.env.FAKE_DISCORD_REST_PATH || "/api/v10/gateway",
  method: "GET",
  rejectUnauthorized: false,
  headers: { "User-Agent": "nemoclaw-e2e-node" },
};

const req = https.request(options, (res) => {
  let body = "";
  res.on("data", (chunk) => {
    body += chunk;
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
req.end();
NODE
}

run_fake_discord_rest_curl_request() {
  local port="$1"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  sandbox_exec "set +e
rm -f /tmp/nemoclaw-fake-discord-curl.err /tmp/nemoclaw-fake-discord-curl.body
curl -k -v --max-time 15 https://$host:$port/api/v10/gateway \
  -A nemoclaw-e2e-curl \
  -o /tmp/nemoclaw-fake-discord-curl.body \
  2>/tmp/nemoclaw-fake-discord-curl.err
rc=\$?
printf 'RC=%s\n' \"\$rc\"
grep -E 'Uses proxy|CONNECT .* HTTP|HTTP/1\\.[01] 403|CONNECT tunnel failed|Connection established|policy_denied|Forbidden' /tmp/nemoclaw-fake-discord-curl.err /tmp/nemoclaw-fake-discord-curl.body 2>/dev/null || true
" 2>/dev/null || true
}

fake_discord_rest_capture_counts() {
  node - "$FAKE_DISCORD_REST_CAPTURE_FILE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
const requests = rows.filter((row) => row.event === "request");
const node = requests.filter((row) => String(row.userAgent || "").includes("nemoclaw-e2e-node")).length;
const curl = requests.filter((row) => String(row.userAgent || "").includes("nemoclaw-e2e-curl")).length;
console.log(`requests=${requests.length} node=${node} curl=${curl}`);
NODE
}
