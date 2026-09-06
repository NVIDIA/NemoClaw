// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "../../..", "scripts", "managed-gateway-control.py");
const HERMES_HASH_HARNESS = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("managed_control_hash", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

digest = "a" * 64
config = f"{digest}  /sandbox/.hermes/config.yaml"
environment = f"{digest}  /sandbox/.hermes/.env"
state = (
    "# nemoclaw-hermes-mcp-state-v1 "
    f"intended={digest} applied={digest}"
)

def parse(*lines):
    try:
        return control._parse_locked_hermes_hash(
            ("\n".join(lines) + "\n").encode("ascii")
        )
    except control.ControlError as error:
        return error.code

print(json.dumps({
    "legacy": parse(config, environment),
    "current": parse(config, environment, state),
    "state_first": parse(state, config, environment),
    "state_between": parse(config, state, environment),
    "malformed_state": parse(config, environment, state + " trailing"),
    "duplicate_state": parse(config, environment, state, state),
    "unknown_comment": parse(config, environment, "# untrusted metadata"),
    "duplicate_path": parse(config, config, environment),
}, sort_keys=True))
`;

describe("managed gateway Hermes hash records", () => {
  it("accepts the authenticated MCP state record and rejects ambiguous hash files (#7499)", () => {
    const result = spawnSync("python3", ["-c", HERMES_HASH_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    const digest = "a".repeat(64);
    const expectedRecords = {
      "/sandbox/.hermes/config.yaml": digest,
      "/sandbox/.hermes/.env": digest,
    };
    expect(JSON.parse(result.stdout)).toEqual({
      legacy: expectedRecords,
      current: expectedRecords,
      state_first: "GATEWAY_CONFIG_HASH_MISMATCH",
      state_between: "GATEWAY_CONFIG_HASH_MISMATCH",
      malformed_state: "GATEWAY_CONFIG_HASH_MISMATCH",
      duplicate_state: "GATEWAY_CONFIG_HASH_MISMATCH",
      unknown_comment: "GATEWAY_CONFIG_HASH_MISMATCH",
      duplicate_path: "GATEWAY_CONFIG_HASH_MISMATCH",
    });
  });
});
