// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/mcp-config-transaction.py",
);

describe("Hermes managed MCP credential revisions", () => {
  it("matches only the exact credential or a bounded revision of the same placeholder", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {"server": "fake", "url": "https://mcp.example.test/mcp", "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"}, "replace_existing": False}
expected = module._managed_candidate(payload)
def actual(authorization):
    value = dict(expected)
    value["headers"] = {"Authorization": authorization}
    return value
print(json.dumps([
    module._managed_candidate_matches(expected, expected, True),
    module._managed_candidate_matches(actual("Bearer openshell:resolve:env:v12_FAKE_TOKEN"), expected, True),
    module._managed_candidate_matches(actual("Bearer openshell:resolve:env:v12_OTHER_TOKEN"), expected, True),
    module._managed_candidate_matches(actual("Bearer openshell:resolve:env:v_FAKE_TOKEN"), expected, True),
    module._managed_candidate_matches(actual("Bearer openshell:resolve:env:v12_FAKE_TOKEN"), expected, False),
]))`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, true, false, false, false]);
  });
});
