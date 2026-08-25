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

describe("Hermes MCP credential revision transaction", () => {
  it("accepts bounded revisions and preserves exact revision comparison (#10155)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def payload(authorization):
    return {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": authorization},
        "replace_existing": True,
    }

canonical = payload("Bearer openshell:resolve:env:FAKE_TOKEN")
revisioned = payload("Bearer openshell:resolve:env:v12_FAKE_TOKEN")
os.environ["FAKE_TOKEN"] = "openshell:resolve:env:v12_FAKE_TOKEN"
invalid = {
    "malformed": payload("Bearer openshell:resolve:env:v12-FAKE_TOKEN"),
    "overlong": payload("Bearer openshell:resolve:env:v" + "1" * 21 + "_FAKE_TOKEN"),
    "reservedName": payload("Bearer openshell:resolve:env:v12_GCP_PROJECT_ID"),
    "unobserved": payload("Bearer openshell:resolve:env:v12_OTHER_TOKEN"),
    "unsupportedMetadata": {**revisioned, "credential_revision": "v12"},
}

validation = {}
for name, candidate in {"canonical": canonical, "revisioned": revisioned, **invalid}.items():
    try:
        module._validate_payload("add", candidate)
        validation[name] = "accepted"
    except ValueError:
        validation[name] = "rejected"

canonical_candidate = module._managed_candidate(canonical)
revisioned_candidate = module._managed_candidate(revisioned)
stale_candidate = module._managed_candidate(
    payload("Bearer openshell:resolve:env:v11_FAKE_TOKEN")
)
comparison = {
    "bounded": module._managed_candidate_matches(
        revisioned_candidate, canonical_candidate, True
    ),
    "exactRejectsRevision": module._managed_candidate_matches(
        revisioned_candidate, canonical_candidate, False
    ),
    "exactRejectsStale": module._managed_candidate_matches(
        stale_candidate, revisioned_candidate, True
    ),
    "exactAcceptsCurrent": module._managed_candidate_matches(
        revisioned_candidate, revisioned_candidate, False
    ),
}
print(json.dumps({"validation": validation, "comparison": comparison}))`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      validation: {
        canonical: "accepted",
        revisioned: "accepted",
        malformed: "rejected",
        overlong: "rejected",
        reservedName: "rejected",
        unobserved: "rejected",
        unsupportedMetadata: "rejected",
      },
      comparison: {
        bounded: true,
        exactRejectsRevision: false,
        exactRejectsStale: false,
        exactAcceptsCurrent: true,
      },
    });
  });
});
