// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "hermes-adapter.py");
const PLACEHOLDER = "openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN";
const SUBSCRIPTION = "projects/nemoclaw-test/subscriptions/hermes-chat";

// Stand-ins for the two imports the override reaches for at runtime. The bundled
// Hermes adapter and aiohttp both live in the sandbox image, so the checked-in
// test supplies the smallest surface `_rest_pull` touches.
const HERMES_STUB = `
class GoogleChatAdapter:
    """Only what the subclass definition needs; _rest_pull calls none of it."""


class AuthorizedHttp:
    def __init__(self, credentials, http=None):
        self.credentials = credentials
        self.http = http
`;

const AIOHTTP_STUB = `
"""Recording aiohttp double. Every request lands in REQUESTS; responses are scripted."""

REQUESTS = []
SCRIPT = []


class ClientTimeout:
    def __init__(self, total=None):
        self.total = total


class _Response:
    def __init__(self, status, payload=None, text=""):
        self.status = status
        self._payload = payload if payload is not None else {}
        self._text = text

    async def json(self):
        return self._payload

    async def text(self):
        return self._text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False


class ClientSession:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    def post(self, url, json=None, headers=None, timeout=None):
        REQUESTS.append(
            {
                "url": url,
                "method": "POST",
                "authorization": (headers or {}).get("Authorization"),
                "body": json,
            }
        )
        if not SCRIPT:
            raise AssertionError("aiohttp double ran out of scripted responses: " + url)
        status, payload, on_send = SCRIPT.pop(0)
        if on_send is not None:
            on_send()
        if status == "transport-error":
            raise OSError("proxy refused the acknowledge")
        return _Response(status, payload)
`;

// Drives the real _rest_pull against the doubles above and prints what crossed the
// wire. Scenario names match the test titles below.
const DRIVER = `
import asyncio
import base64
import importlib.util
import json
import sys

import aiohttp

ADAPTER_PATH, SCENARIO = sys.argv[1], sys.argv[2]
SUBSCRIPTION = ${JSON.stringify(SUBSCRIPTION)}

spec = importlib.util.spec_from_file_location("nemoclaw_googlechat_adapter", ADAPTER_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

adapter = object.__new__(module._sandbox_adapter_class())
adapter._sandbox_subscription = SUBSCRIPTION
adapter._shutting_down = False
adapter._max_messages = 1

handled = []


def _received(ack_id, text):
    return {
        "receivedMessages": [
            {
                "ackId": ack_id,
                "message": {"data": base64.b64encode(text.encode()).decode(), "attributes": {}},
            }
        ]
    }


def _stop():
    adapter._shutting_down = True


def _handler(message):
    handled.append(message.data.decode())
    if SCENARIO == "nack":
        message.nack()
    else:
        message.ack()


adapter._on_pubsub_message = _handler

if SCENARIO == "acknowledged":
    aiohttp.SCRIPT.extend(
        [
            (200, _received("ack-1", "hello"), None),
            (200, {}, _stop),
        ]
    )
elif SCENARIO == "acknowledge-fails":
    # The ack is rejected, so Pub/Sub redelivers the same ackId on the next pull.
    aiohttp.SCRIPT.extend(
        [
            (200, _received("ack-1", "hello"), None),
            (500, {}, None),
            (200, _received("ack-1", "hello"), None),
            (200, {}, _stop),
        ]
    )
elif SCENARIO == "acknowledge-raises":
    # The acknowledge never reaches Pub/Sub, so the same ackId comes back.
    aiohttp.SCRIPT.extend(
        [
            (200, _received("ack-1", "hello"), None),
            ("transport-error", None, None),
            (200, _received("ack-1", "hello"), None),
            (200, {}, _stop),
        ]
    )
elif SCENARIO == "nack":
    aiohttp.SCRIPT.extend([(200, _received("ack-1", "hello"), _stop)])
else:
    raise SystemExit("unknown scenario " + SCENARIO)

asyncio.run(adapter._rest_pull())

print(json.dumps({"requests": aiohttp.REQUESTS, "handled": handled}))
`;

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | null;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-googlechat-pull-"));

function runScenario(scenario: string): { requests: RecordedRequest[]; handled: string[] } {
  const result = spawnSync("python3", [path.join(workspace, "driver.py"), ADAPTER, scenario], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: workspace, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 30_000,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
}

describe("Hermes Google Chat keyless REST pull", () => {
  beforeAll(() => {
    const bundled = path.join(workspace, "plugins", "platforms", "google_chat");
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(workspace, "plugins", "__init__.py"), "");
    fs.writeFileSync(path.join(workspace, "plugins", "platforms", "__init__.py"), "");
    fs.writeFileSync(path.join(bundled, "__init__.py"), "");
    fs.writeFileSync(path.join(bundled, "adapter.py"), HERMES_STUB);
    fs.writeFileSync(path.join(workspace, "aiohttp.py"), AIOHTTP_STUB);
    fs.writeFileSync(path.join(workspace, "driver.py"), DRIVER);
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("sends the credential placeholder and nothing else on every request", () => {
    const { requests } = runScenario("acknowledged");

    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([`Bearer ${PLACEHOLDER}`]),
    );
  });

  it("reaches no Pub/Sub operation beyond pull and acknowledge", () => {
    const { requests, handled } = runScenario("acknowledged");

    expect(handled).toEqual(["hello"]);
    expect(new Set(requests.map((request) => `${request.method} ${request.url}`))).toEqual(
      new Set([
        `POST https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:pull`,
        `POST https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:acknowledge`,
      ]),
    );
    const acknowledge = requests.filter((request) => request.url.endsWith(":acknowledge"));
    expect(acknowledge.map((request) => request.body)).toEqual([{ ackIds: ["ack-1"] }]);
  });

  it("keeps a message eligible for redelivery when acknowledgement fails", () => {
    const { requests, handled } = runScenario("acknowledge-fails");

    // The rejected acknowledgement neither raises nor ends the pull, so the
    // redelivered copy is handled again instead of being lost.
    expect(handled).toEqual(["hello", "hello"]);
    expect(requests.filter((request) => request.url.endsWith(":pull"))).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.url.endsWith(":acknowledge"))
        .map((request) => request.body),
    ).toEqual([{ ackIds: ["ack-1"] }, { ackIds: ["ack-1"] }]);
  });

  it("keeps pulling when the acknowledge transport itself fails", () => {
    const { requests, handled } = runScenario("acknowledge-raises");

    // A rejected connection must not escape _rest_pull; letting it end the loop
    // would stop inbound delivery for the whole session, not just this message.
    expect(handled).toEqual(["hello", "hello"]);
    expect(requests.filter((request) => request.url.endsWith(":pull"))).toHaveLength(2);
  });

  it("acknowledges nothing for a message the handler nacks", () => {
    const { requests, handled } = runScenario("nack");

    expect(handled).toEqual(["hello"]);
    expect(requests.filter((request) => request.url.endsWith(":acknowledge"))).toEqual([]);
  });
});
