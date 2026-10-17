// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";

it.each([
  {
    name: "approval command with escaped quotes",
    value: { command: ['public_key = norm(request.get("publicKey"))\nprint("done")'] },
    secrets: [],
    expected: { command: ['public_key = <REDACTED>"publicKey"))\nprint("done")'] },
  },
  {
    name: "registered multiline and quoted values",
    value: { nested: ['synthetic-line-one\nsynthetic-"line-two"'] },
    secrets: ['synthetic-line-one\nsynthetic-"line-two"'],
    expected: { nested: ["[REDACTED]"] },
  },
  {
    name: "opaque credentials identified by property name",
    value: { TOKEN: "syntheticOpaqueCredentialValue", safe: "kept" },
    secrets: [],
    expected: { TOKEN: "<REDACTED>", safe: "kept" },
  },
  {
    name: "managed credential references",
    value: { TOKEN: "openshell:resolve:env:TOKEN", replyToken: "openshell:resolve:env:TOKEN" },
    secrets: [],
    expected: { TOKEN: "openshell:resolve:env:TOKEN", replyToken: "openshell:resolve:env:TOKEN" },
  },
  {
    name: "registered secrets in property names and numeric values",
    value: { "synthetic-key\nvalue": "payload", nested: [1234567890123] },
    secrets: ["synthetic-key\nvalue", "1234567890123"],
    expected: { "[REDACTED]": "<REDACTED>", nested: ["[REDACTED]"] },
  },
])("writes parseable redacted JSON for $name", async ({ value, secrets, expected }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-artifact-json-"));
  try {
    const sink = new ArtifactSink(root, secrets);
    const file = await sink.writeJson("nested/result.json", {
      value,
      exitCode: 0,
      timedOut: false,
      signal: null,
    });
    const text = await fs.readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      value: expected,
      exitCode: 0,
      timedOut: false,
      signal: null,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
