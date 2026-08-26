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
  it("accepts a child-visible bounded revision and preserves exact comparison (#10155)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

os.environ["FAKE_TOKEN"] = "openshell:resolve:env:v12_FAKE_TOKEN"
base = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:v12_FAKE_TOKEN"},
    "replace_existing": True,
}
canonical = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": True,
}
cases = {
    "exact": base,
    "canonical": canonical,
    "malformedRevision": {
        **base,
        "headers": {"Authorization": "Bearer openshell:resolve:env:v-12_FAKE_TOKEN"},
    },
    "overlongRevision": {
        **base,
        "headers": {
            "Authorization": "Bearer openshell:resolve:env:v" + "1" * 21 + "_FAKE_TOKEN"
        },
    },
    "wrongName": {**base, "headers": {"Authorization": "Bearer openshell:resolve:env:v12_OTHER_TOKEN"}},
    "unobserved": {
        **base,
        "headers": {"Authorization": "Bearer openshell:resolve:env:v11_FAKE_TOKEN"},
    },
    "metadataOnAdd": {
        **base,
        "credential_name": "FAKE_TOKEN",
        "credential_revision": "v12",
    },
    "metadataOnRemove": {
        **base,
        "credential_name": "FAKE_TOKEN",
        "credential_revision": "v12",
        "force": False,
    },
}
cases["metadataOnRemove"].pop("replace_existing")
results = {}
for name, payload in cases.items():
    try:
        module._validate_payload("remove" if name == "metadataOnRemove" else "add", payload)
        results[name] = "accepted"
    except ValueError:
        results[name] = "rejected"

canonical_candidate = module._managed_candidate(canonical)
revisioned_candidate = module._managed_candidate(base)
stale_candidate = module._managed_candidate({
    **base,
    "headers": {"Authorization": "Bearer openshell:resolve:env:v11_FAKE_TOKEN"},
})
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
print(json.dumps({"validation": results, "comparison": comparison}))`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      validation: {
        canonical: "accepted",
        exact: "accepted",
        malformedRevision: "rejected",
        metadataOnAdd: "rejected",
        metadataOnRemove: "rejected",
        overlongRevision: "rejected",
        unobserved: "rejected",
        wrongName: "rejected",
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
