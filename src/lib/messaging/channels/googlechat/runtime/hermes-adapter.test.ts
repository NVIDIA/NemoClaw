// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "hermes-adapter.py");
// What OpenShell 0.0.106 injects; the adapter must forward it verbatim.
const PLACEHOLDER = "openshell:resolve:env:v7_GOOGLE_CHAT_ACCESS_TOKEN";
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
    def __init__(self, status, payload):
        self.status, self._payload = status, payload or {}

    async def json(self):
        return self._payload

    async def text(self):
        return ""

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
            {"url": url, "method": "POST", "authorization": (headers or {}).get("Authorization"), "body": json}
        )
        # Raise rather than assert: python -O strips assert statements, and an
        # inherited PYTHONOPTIMIZE would silently turn the refusal below into an
        # ordinary non-200 response, passing the test without its claim.
        if not SCRIPT:
            raise AssertionError("aiohttp double ran out of scripted responses: " + url)
        status, payload, on_send = SCRIPT.pop(0)
        on_send and on_send()
        if status == "transport-error":
            raise ConnectionError("proxy refused the acknowledge")
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
    message = {"data": base64.b64encode(text.encode()).decode(), "attributes": {}}
    return {"receivedMessages": [{"ackId": ack_id, "message": message}]}


def _stop():
    adapter._shutting_down = True


def _handler(message):
    handled.append(message.data.decode())
    message.nack() if SCENARIO == "nack" else message.ack()


adapter._on_pubsub_message = _handler
delivery, redelivery = _received("ack-1", "hello"), _received("ack-1", "hello")

# Two corrupted deliveries: an entry that is not a mapping at all, and one whose
# base64 cannot be decoded. Both raise while the message is shaped, and only the
# second carries an ack id to retire it with. The scenario also opens with a pull
# body whose receivedMessages is not iterable, which fails both on the read and on
# the loop over it; an empty container would be coerced to {} by the double and
# prove nothing.
malformed = {"receivedMessages": [None, {"ackId": "ack-bad", "message": {"data": "abcde"}}]}

# Each entry is (pull or acknowledge response status, payload, side effect).
# A rejected acknowledge means Pub/Sub redelivers the same ackId on the next pull.
aiohttp.SCRIPT.extend(
    {
        "acknowledged": [(200, delivery, None), (200, {}, _stop)],
        "acknowledge-fails": [
            (200, delivery, None), (500, {}, None), (200, redelivery, None), (200, {}, _stop),
        ],
        "acknowledge-raises": [
            (200, delivery, None),
            ("transport-error", None, None),
            (200, redelivery, None),
            (200, {}, _stop),
        ],
        "malformed-payload": [
            (200, {"receivedMessages": 1}, None), (200, malformed, None), (200, {}, None),
            (200, delivery, None), (200, {}, _stop),
        ],
        "nack": [(200, delivery, _stop)],
    }[SCENARIO]
)

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
    env: {
      ...process.env,
      GOOGLE_CHAT_ACCESS_TOKEN: PLACEHOLDER,
      PYTHONPATH: workspace,
      PYTHONDONTWRITEBYTECODE: "1",
    },
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

  it("sends only the credential placeholder, and only to pull and acknowledge", () => {
    const { requests, handled } = runScenario("acknowledged");

    expect(handled).toEqual(["hello"]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([`Bearer ${PLACEHOLDER}`]),
    );
    expect(new Set(requests.map((request) => `${request.method} ${request.url}`))).toEqual(
      new Set([
        `POST https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:pull`,
        `POST https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:acknowledge`,
      ]),
    );
    expect(
      requests.filter((request) => request.url.endsWith(":acknowledge")).map((r) => r.body),
    ).toEqual([{ ackIds: ["ack-1"] }]);
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

  it("retires an undecodable delivery and survives a malformed pull response", () => {
    const { requests, handled } = runScenario("malformed-payload");

    // Reading the response envelope and shaping each message both raise here:
    // receivedMessages is not iterable, one entry is not a mapping, and one payload
    // is not decodable. Any of them ending the pull would silence inbound for the
    // rest of the session, and leaving the entry that has an ack id unacknowledged
    // would permit repeated poison-message redelivery.
    expect(handled).toEqual(["hello"]);
    expect(requests.filter((request) => request.url.endsWith(":pull"))).toHaveLength(3);
    expect(
      requests
        .filter((request) => request.url.endsWith(":acknowledge"))
        .map((request) => request.body),
    ).toEqual([{ ackIds: ["ack-bad"] }, { ackIds: ["ack-1"] }]);
  });

  it("acknowledges nothing for a message the handler nacks", () => {
    const { requests, handled } = runScenario("nack");

    expect(handled).toEqual(["hello"]);
    expect(requests.filter((request) => request.url.endsWith(":acknowledge"))).toEqual([]);
  });

  // Fail closed: with no injected credential there is no bearer to forward, and
  // a silent request would surface as an opaque egress denial instead.
  it("refuses to build a bearer when the injected credential is absent", () => {
    const result = spawnSync("python3", [path.join(workspace, "driver.py"), ADAPTER, "acknowledged"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_CHAT_ACCESS_TOKEN: "",
        PYTHONPATH: workspace,
        PYTHONDONTWRITEBYTECODE: "1",
      },
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("GOOGLE_CHAT_ACCESS_TOKEN is not set");
  });
});
