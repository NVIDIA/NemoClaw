// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "../fixtures/e2e-test.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  type AgentKind,
  expectExitZero,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const OPENCLAW_BOUNDARY_PROOF = String.raw`
const https = require("node:https");
const token = process.env.GOOGLE_CHAT_ACCESS_TOKEN || "";
if (!/^openshell:resolve:env:v[1-9][0-9]*_GOOGLE_CHAT_ACCESS_TOKEN$/.test(token)) {
  throw new Error("Google Chat credential is not revision-scoped");
}
const request = https.get({
  hostname: "chat.googleapis.com",
  path: "/v1/spaces/nemoclaw-e2e-missing",
  headers: { Authorization: "Bearer " + token },
}, (response) => {
  response.resume();
  response.on("end", () => {
    console.log(JSON.stringify({ placeholder: "revision-scoped", statuses: [response.statusCode] }));
  });
});
request.on("error", (error) => {
  throw error;
});
request.setTimeout(30000, () => request.destroy(new Error("Google Chat boundary request timed out")));
`;

const HERMES_BOUNDARY_PROOF = String.raw`
import asyncio
import importlib.util
import json
import os
import re
import sys

import aiohttp

token = (os.environ.get("GOOGLE_CHAT_ACCESS_TOKEN") or "").strip()
if not re.fullmatch(r"openshell:resolve:env:v[1-9][0-9]*_GOOGLE_CHAT_ACCESS_TOKEN", token):
    raise RuntimeError("Google Chat credential is not revision-scoped")

sys.path.insert(0, "/opt/hermes")
override_path = "/sandbox/.hermes/plugins/nemoclaw/googlechat_adapter.py"
spec = importlib.util.spec_from_file_location("nemoclaw_googlechat_e2e", override_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
adapter_class = module._sandbox_adapter_class()

subscription = "projects/nemoclaw-e2e/subscriptions/missing"
urls = [
    f"https://pubsub.googleapis.com/v1/{subscription}:pull",
    f"https://pubsub.googleapis.com/v1/{subscription}:acknowledge",
]

async def run():
    proxy = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or None
    )
    statuses = []
    async with aiohttp.ClientSession(trust_env=True) as session:
        for url, body in zip(urls, ({"maxMessages": 1}, {"ackIds": ["e2e-missing"]})):
            async with session.post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {token}"},
                proxy=proxy,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                await response.read()
                statuses.append(response.status)
    return statuses

print(json.dumps({
    "installedOverride": adapter_class.__name__ == "SandboxGoogleChatAdapter",
    "placeholder": "revision-scoped",
    "statuses": asyncio.run(run()),
}))
`;

export interface GooglechatProviderEgressProof {
  readonly installedOverride?: boolean;
  readonly placeholder: string;
  readonly statuses: number[];
}

export function parseGooglechatProviderEgressProof(stdout: string): GooglechatProviderEgressProof {
  const lastLine = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
  return JSON.parse(lastLine) as GooglechatProviderEgressProof;
}

export function assertGooglechatProviderEgressProof(
  proof: GooglechatProviderEgressProof,
  agent: AgentKind,
): void {
  expect(proof.placeholder, "sandbox process received a revision-scoped placeholder").toBe(
    "revision-scoped",
  );
  // A 401 proves the policy allowed the fixture request to reach Google. It
  // does not distinguish the fixed fixture token from an unresolved
  // placeholder, so this assertion intentionally makes no rewrite claim.
  expect(
    proof.statuses,
    "Google APIs returned the expected response for the non-secret fixture request",
  ).toEqual(agent === "openclaw" ? [401] : [401, 401]);
  if (agent === "hermes") {
    expect(proof.installedOverride, "installed Hermes Google Chat override loaded").toBe(true);
  }
}

export async function expectGooglechatProviderEgress(
  sandbox: SandboxClient,
  sandboxName: string,
  agent: AgentKind,
  context: string,
  redactionValues: string[],
): Promise<void> {
  const source = agent === "openclaw" ? OPENCLAW_BOUNDARY_PROOF : HERMES_BOUNDARY_PROOF;
  const command =
    agent === "openclaw"
      ? `node -e ${shellQuote(source)}`
      : `/opt/hermes/.venv/bin/python -c ${shellQuote(source)}`;
  const result = await sandboxSh(sandbox, sandboxName, command, {
    artifactName: `googlechat-provider-egress-${agent}-${context}`,
    redactionValues,
    timeoutMs: 90_000,
  });
  expectExitZero(result, `${agent} Google Chat provider egress ${context}`);

  assertGooglechatProviderEgressProof(parseGooglechatProviderEgressProof(result.stdout), agent);
}
