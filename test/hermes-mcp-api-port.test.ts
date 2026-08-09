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

describe("Hermes MCP API port resolution", () => {
  it("accepts only allocated ports from the stable service-manager environment", () => {
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
identity = (41, 333)
module._gateway_identity = lambda: identity
module._process_parent_pid = lambda pid: 40
module._is_service_manager_process = lambda pid: True

accepted = []
for raw in (b"8642", b"8645", b"8652"):
    module._read_service_manager_environment = (
        lambda pid, value=raw: b"PATH=/usr/bin\\0NEMOCLAW_HERMES_API_PORT="
        + value
        + b"\\0"
    )
    accepted.append(module._service_manager_gateway_public_port(identity))

rejected = []
for raw in (
    b"8641",
    b"8653",
    "²".encode("utf-8"),
    b"8645\\0NEMOCLAW_HERMES_API_PORT=8646",
):
    module._read_service_manager_environment = (
        lambda pid, value=raw: b"NEMOCLAW_HERMES_API_PORT=" + value + b"\\0"
    )
    try:
        module._service_manager_gateway_public_port(identity)
    except PermissionError as error:
        rejected.append(str(error))

module._read_service_manager_environment = lambda pid: b"PATH=/usr/bin\\0"
absent = module._service_manager_gateway_public_port(identity)

module._gateway_identity = lambda: (41, 999)
module._read_service_manager_environment = (
    lambda pid: b"NEMOCLAW_HERMES_API_PORT=8645\\0"
)
identity_change = ""
try:
    module._service_manager_gateway_public_port(identity)
except PermissionError as error:
    identity_change = str(error)

print(json.dumps({
    "accepted": accepted,
    "rejected": rejected,
    "absent": absent,
    "identity_change": identity_change,
}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: [8642, 8645, 8652],
      rejected: [
        "Hermes API port is outside the allocated range",
        "Hermes API port is outside the allocated range",
        "Hermes service-manager API port is malformed",
        "Hermes service-manager API port is ambiguous",
      ],
      absent: 8642,
      identity_change: "Hermes service-manager identity changed while reading",
    });
  });
});
