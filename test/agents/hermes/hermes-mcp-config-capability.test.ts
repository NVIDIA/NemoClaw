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

describe("Hermes managed MCP helper capability", () => {
  it("advertises versioned reconcile-finality support without mutating config", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import contextlib, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module._configure_gateway_public_port = lambda: None
module._mcp_transaction_lock = contextlib.nullcontext
module.apply_transaction_and_reload = lambda action, payload: (_ for _ in ()).throw(RuntimeError("must not mutate"))
print(json.dumps(module.probe(), sort_keys=True))
`,
        TRANSACTION,
      ],
      { encoding: "utf8", env: process.env },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      capabilities: { reconcile_finality: 1 },
      ok: true,
    });
  });
});
