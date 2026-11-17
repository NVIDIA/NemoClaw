// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { buildProviderNeutralInferenceSandboxSmokeScript } from "../compatible-endpoint-smoke";
import fs from "node:fs";
import path from "node:path";

export function writeSmokeConfig(tmpDir: string, model: string): string {
  const configDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { defaults: { model: { primary: `inference/${model}` } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
          },
        },
      },
    }),
  );
  return configPath;
}

export function writeFakeCurl(
  tmpDir: string,
  bodyForCall: string,
): { binDir: string; callFile: string; requestFile: string } {
  const binDir = path.join(tmpDir, "bin");
  const callFile = path.join(tmpDir, "curl-calls");
  const requestFile = path.join(tmpDir, "curl-request.json");
  const responseScript = path.join(tmpDir, "fake-curl-response.sh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(responseScript, `#!/usr/bin/env bash\nset -eu\n${bodyForCall}\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -eu
call_file="${callFile}"
count=0
if [ -f "$call_file" ]; then
  count="$(cat "$call_file")"
fi
count=$((count + 1))
printf '%s' "$count" >"$call_file"
output_file=""
write_out=""
data_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      write_out="$2"
      shift 2
      ;;
    -d)
      data_file="\${2#@}"
      shift 2
      ;;
    *) shift ;;
  esac
done
if [ -n "$data_file" ]; then
  cp "$data_file" "${requestFile}"
fi
set +e
body="$(count="$count" "${responseScript}")"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  exit "$rc"
fi
http_status=200
case "$body" in
  __HTTP_STATUS__=*)
    status_line="\${body%%$'\n'*}"
    http_status="\${status_line#__HTTP_STATUS__=}"
    body="\${body#*$'\n'}"
    ;;
  *"504 Gateway Time-out"*) http_status=504 ;;
esac
if [ -n "$output_file" ]; then
  printf '%s' "$body" >"$output_file"
  if [ "$write_out" = '%{http_code}' ]; then
    printf '%s' "$http_status"
  fi
else
  printf '%s\n' "$body"
fi
`,
    { mode: 0o755 },
  );
  return { binDir, callFile, requestFile };
}

export function writeFakeSleep(tmpDir: string, binDir: string): string {
  const sleepFile = path.join(tmpDir, "sleep-calls");
  fs.writeFileSync(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
set -eu
printf '%s\n' "$1" >>"${sleepFile}"
`,
    { mode: 0o755 },
  );
  return sleepFile;
}

export function runSmokeScript(script: string, tmpDir: string, binDir: string) {
  return spawnSync("sh", ["-c", script], {
    cwd: tmpDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    },
  });
}

type ProviderNeutralAuthority = NonNullable<
  Parameters<typeof buildProviderNeutralInferenceSandboxSmokeScript>[1]
>;

export function providerNeutralResponses(
  model: string,
  includeToolCall = true,
  toolArguments: unknown = "{}",
): unknown[] {
  return [
    { model, choices: [{ message: { content: "PONG" } }] },
    {
      model,
      choices: [
        {
          message: {
            tool_calls: includeToolCall
              ? [
                  {
                    function: {
                      name: "nemoclaw_route_probe",
                      arguments: toolArguments,
                    },
                  },
                ]
              : [],
          },
        },
      ],
    },
  ];
}

export function runProviderNeutralScript(options: {
  authority: ProviderNeutralAuthority;
  model?: string;
  script?: string;
  responses?: unknown[];
  denial?: unknown;
  denialBytes?: readonly number[];
  denialOversized?: boolean;
  directError?: "connection-refused" | "dns" | "timeout";
  directAddresses?: readonly string[];
  directOutcomes?: Readonly<
    Record<
      string,
      "connection-refused" | "network-unreachable" | "host-unreachable" | "timeout" | "http-200"
    >
  >;
  managedProxyResponses?: unknown[];
  inferenceUrl?: string;
  expectedAuthorization?: string;
  runtimeEnvironment?: NodeJS.ProcessEnv;
}) {
  const model = options.model ?? "qwen3.5-9b";
  const directAuthority = `host.openshell.internal:${String(options.authority.directHostPort)}`;
  const responses = options.responses ?? providerNeutralResponses(model);
  const denial =
    options.denial ??
    ({
      error: "policy_denied",
      detail: `POST ${directAuthority}/v1/chat/completions not permitted by policy`,
    } satisfies Record<string, string>);
  const denialBytes =
    options.denialBytes ?? Array.from(Buffer.from(JSON.stringify(denial), "utf8"));
  const denialBody = options.denialOversized
    ? 'b"x" * 1048577'
    : `bytes(${JSON.stringify(denialBytes)})`;
  const prelude = `
import atexit
import errno
import http.client
import json
import socket
import time
import urllib.error
import urllib.request

responses = json.loads(${JSON.stringify(JSON.stringify(responses))})
managed_proxy_responses = json.loads(${JSON.stringify(
    JSON.stringify(options.managedProxyResponses ?? []),
  )})
managed_proxy_enabled = ${options.managedProxyResponses === undefined ? "False" : "True"}
denial_bytes = ${denialBody}
direct_addresses = json.loads(${JSON.stringify(
    JSON.stringify(options.directAddresses ?? ["192.168.65.254"]),
  )})
direct_outcomes = json.loads(${JSON.stringify(JSON.stringify(options.directOutcomes ?? {}))})
inference_request_tokens = []
direct_request_count = []
direct_request_urls = []
direct_request_addresses = []
direct_request_hosts = []
managed_proxy_request_count = []
managed_proxy_request_urls = []
sleep_delays = []
direct_error = ${options.directError === undefined ? "None" : JSON.stringify(options.directError)}

def emit_request_evidence():
    print("INFERENCE_REQUEST_TOKENS=" + ",".join(str(value) for value in inference_request_tokens))
    print("DIRECT_REQUEST_COUNT=" + str(len(direct_request_count)))
    print("DIRECT_REQUEST_URLS=" + ",".join(direct_request_urls))
    print("DIRECT_REQUEST_ADDRESSES=" + ",".join(direct_request_addresses))
    print("DIRECT_REQUEST_HOSTS=" + ",".join(direct_request_hosts))
    print("MANAGED_PROXY_REQUEST_COUNT=" + str(len(managed_proxy_request_count)))
    print("MANAGED_PROXY_REQUEST_URLS=" + ",".join(managed_proxy_request_urls))
    print("SLEEP_DELAYS=" + ",".join(str(value) for value in sleep_delays))

atexit.register(emit_request_evidence)

class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.payload_source = payload
        self.payload = json.dumps(payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, traceback):
        return False
    def read(self, size=-1):
        if isinstance(self.payload_source, dict) and self.payload_source.get("__oversized__") is True:
            return b"x" * (size if size >= 0 else 1048577)
        return self.payload if size < 0 else self.payload[:size]

class FakeDirectResponse:
    def __init__(self, status):
        self.status = status
    def read(self, size=-1):
        return denial_bytes if size < 0 else denial_bytes[:size]

class FakeOpener:
    def open(self, request, timeout):
        if request.full_url == ${JSON.stringify(options.inferenceUrl ?? "https://inference.local/v1/chat/completions")}:
            assert request.get_header("Authorization") == ${options.expectedAuthorization ? JSON.stringify(options.expectedAuthorization) : "None"}
            if not responses:
                raise RuntimeError("test response queue exhausted")
            request_data = json.loads(request.data.decode("utf-8"))
            inference_request_tokens.append(
                request_data.get("max_tokens", request_data.get("max_completion_tokens"))
            )
            if responses[0] == "__timeout__":
                raise TimeoutError("timed out after %s seconds" % timeout)
            if responses[0] == "__wrapped_timeout__":
                raise urllib.error.URLError(TimeoutError("timed out after %s seconds" % timeout))
            return FakeResponse(200, responses.pop(0))
        raise RuntimeError("unexpected direct request through inference opener")

def fake_getaddrinfo(host, port, type=0):
    if direct_error == "dns":
        raise socket.gaierror(socket.EAI_NONAME, "not known")
    return [
        (
            socket.AF_INET6 if ":" in address else socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            (address, port, 0, 0) if ":" in address else (address, port),
        )
        for address in direct_addresses
    ]

class FakeSocket:
    def __init__(self, family, type):
        self.address = None
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, traceback):
        return False
    def settimeout(self, timeout):
        pass
    def connect(self, sockaddr):
        self.address = sockaddr[0]
        direct_request_count.append(1)
        direct_request_urls.append(direct_url)
        direct_request_addresses.append(self.address)
        outcome = direct_outcomes.get(self.address, direct_error)
        if outcome == "connection-refused":
            raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")
        if outcome == "network-unreachable":
            raise OSError(errno.ENETUNREACH, "network unreachable")
        if outcome == "host-unreachable":
            raise OSError(errno.EHOSTUNREACH, "host unreachable")
        if outcome == "timeout":
            raise TimeoutError("timed out")

class FakeHTTPConnection:
    def __init__(self, host, port, timeout):
        self.sock = None
    def request(self, method, path, body, headers):
        direct_request_hosts.append(headers.get("Host"))
    def getresponse(self):
        outcome = direct_outcomes.get(self.sock.address, direct_error)
        return FakeDirectResponse(200 if outcome == "http-200" else 403)
    def close(self):
        pass

socket.getaddrinfo = fake_getaddrinfo
socket.socket = FakeSocket
http.client.HTTPConnection = FakeHTTPConnection

class ManagedProxyOpener:
    def open(self, request, timeout):
        managed_proxy_request_count.append(1)
        managed_proxy_request_urls.append(request.full_url)
        if not managed_proxy_responses:
            raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))
        request_data = json.loads(request.data.decode("utf-8"))
        inference_request_tokens.append(
            request_data.get("max_tokens", request_data.get("max_completion_tokens"))
        )
        return FakeResponse(200, managed_proxy_responses.pop(0))

def build_test_opener(*handlers):
    if managed_proxy_enabled:
        return ManagedProxyOpener()
    return FakeOpener()

urllib.request.build_opener = build_test_opener
time.sleep = lambda seconds: sleep_delays.append(seconds)
`;
  const script =
    options.script ?? buildProviderNeutralInferenceSandboxSmokeScript(model, options.authority);
  return spawnSync("python3", ["-c", `${prelude}\n${script}`], {
    encoding: "utf8",
    env:
      options.managedProxyResponses === undefined
        ? { ...process.env, ...options.runtimeEnvironment }
        : {
            ...process.env,
            HTTPS_PROXY: "http://openshell-runtime-proxy.invalid:8080",
            NO_PROXY: "",
          },
  });
}
