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
  it("accepts only the exact bounded revision declared by the host (#10155)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

base = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:v12_FAKE_TOKEN"},
    "replace_existing": True,
    "credential_name": "FAKE_TOKEN",
    "credential_revision": "v12",
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
    "missingRevision": {key: value for key, value in base.items() if key != "credential_revision"},
    "missingName": {key: value for key, value in base.items() if key != "credential_name"},
    "mismatchedRevision": {**base, "credential_revision": "v11"},
    "malformedRevision": {**base, "credential_revision": "v"},
    "overlongRevision": {**base, "credential_revision": "v" + "1" * 21},
    "wrongName": {**base, "headers": {"Authorization": "Bearer openshell:resolve:env:v12_OTHER_TOKEN"}},
    "metadataOnRemove": {**base, "force": False},
}
cases["metadataOnRemove"].pop("replace_existing")
results = {}
for name, payload in cases.items():
    try:
        module._validate_payload("remove" if name == "metadataOnRemove" else "add", payload)
        results[name] = "accepted"
    except ValueError:
        results[name] = "rejected"
print(json.dumps(results))`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      exact: "accepted",
      canonical: "accepted",
      missingRevision: "rejected",
      missingName: "rejected",
      mismatchedRevision: "rejected",
      malformedRevision: "rejected",
      overlongRevision: "rejected",
      wrongName: "rejected",
      metadataOnRemove: "rejected",
    });
  });
});
