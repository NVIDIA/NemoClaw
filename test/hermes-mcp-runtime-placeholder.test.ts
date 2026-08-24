// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "..",
  "agents/hermes/mcp-config-transaction.py",
);

describe("Hermes managed MCP runtime placeholders", () => {
  it("materializes only bounded OpenShell runtime placeholders", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": True,
}
os.environ["FAKE_TOKEN"] = "openshell:resolve:env:v42_FAKE_TOKEN"
projected = module._materialize_runtime_payload("add", payload)
bad = []
for value in (
    "raw-secret",
    "openshell:resolve:env:v_FAKE_TOKEN",
    "openshell:resolve:env:v42_OTHER_TOKEN",
    "openshell:resolve:env:v123456789012345678901_FAKE_TOKEN",
):
    os.environ["FAKE_TOKEN"] = value
    try:
        module._materialize_runtime_payload("add", payload)
    except ValueError as error:
        bad.append(str(error))
print(json.dumps({"projected": projected, "bad": bad}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8", env: { ...process.env } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      projected: {
        server: "fake",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer openshell:resolve:env:v42_FAKE_TOKEN" },
        replace_existing: true,
      },
      bad: Array(4).fill(
        "Hermes MCP credential environment does not contain a bounded OpenShell placeholder",
      ),
    });
  });
});
