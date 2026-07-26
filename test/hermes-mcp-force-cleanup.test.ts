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

describe("Hermes MCP forced cleanup", () => {
  it("removes legacy percent-path entries by validated server name", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
results = []
for suffix in ("%", "%GG", "%2"):
    url = f"https://mcp.example.test/{suffix}"
    payload = {
        "server": "legacy",
        "url": url,
        "headers": {"Authorization": "Bearer openshell:resolve:env:LEGACY_TOKEN"},
        "force": True,
    }
    module._validate_payload("remove", payload)
    updated, changed = module._mutate(
        {"mcp_servers": {"legacy": {"url": url}, "other": {"url": "https://other.test/mcp"}}},
        "remove",
        payload,
    )
    try:
        module._validate_payload("remove", {**payload, "force": False})
    except ValueError:
        non_force_rejected = True
    else:
        non_force_rejected = False
    results.append({
        "changed": changed,
        "legacy_removed": "legacy" not in updated["mcp_servers"],
        "other_preserved": "other" in updated["mcp_servers"],
        "non_force_rejected": non_force_rejected,
    })
print(json.dumps(results))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      Array.from({ length: 3 }, () => ({
        changed: true,
        legacy_removed: true,
        other_preserved: true,
        non_force_rejected: true,
      })),
    );
  });
});
