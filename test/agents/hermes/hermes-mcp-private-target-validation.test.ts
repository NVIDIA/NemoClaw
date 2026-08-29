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

function runPython(source: string) {
  return spawnSync("python3", ["-c", source, TRANSACTION], {
    encoding: "utf8",
  });
}

describe("Hermes managed MCP private target validation", () => {
  it("accepts host-validated private targets without accepting malformed or unsupported hosts (#8267)", () => {
    const result = runPython(`
import importlib.util, json, sys, types
yaml_stub = types.ModuleType("yaml")
yaml_stub.YAMLError = Exception
sys.modules["yaml"] = yaml_stub
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

accepted_urls = (
    "https://8.8.8.8/mcp",
    "https://10.20.30.40/mcp",
    "https://mcp.corp.internal/mcp",
)
rejected_urls = (
    "https://host.openshell.internal/mcp",
    "https://host.docker.internal/mcp",
    "https://host.containers.internal/mcp",
    "https://mcp..corp.internal/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/mcp",
    "https://0177.0.0.1/mcp",
    "https://[fc00::1]/mcp",
)

def payload(url):
    return {
        "server": "fake",
        "url": url,
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }

accepted = []
for url in accepted_urls:
    module._validate_payload("add", payload(url))
    accepted.append(url)
rejected = []
for url in rejected_urls:
    try:
        module._validate_payload("add", payload(url))
    except ValueError:
        rejected.append(url)
print(json.dumps({"accepted": accepted, "rejected": rejected}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: ["https://8.8.8.8/mcp", "https://10.20.30.40/mcp", "https://mcp.corp.internal/mcp"],
      rejected: [
        "https://host.openshell.internal/mcp",
        "https://host.docker.internal/mcp",
        "https://host.containers.internal/mcp",
        "https://mcp..corp.internal/mcp",
        "https://127.0.0.1/mcp",
        "https://169.254.169.254/mcp",
        "https://0177.0.0.1/mcp",
        "https://[fc00::1]/mcp",
      ],
    });
  });
});
