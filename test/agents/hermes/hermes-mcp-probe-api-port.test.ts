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

describe("Hermes MCP lifecycle probe API port", () => {
  it("probes the same-UID helper without mutating config (#8543)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
module.os.lstat = lambda path: (_ for _ in ()).throw(FileNotFoundError(path))
module._gateway_identity = lambda: (123, 456)
module._gateway_has_managed_parent = lambda pid: True
module._configure_gateway_public_port = lambda: None
print(json.dumps(module.probe(), sort_keys=True))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it("fails when the root API port marker cannot be resolved (#8543)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module._root_gateway_public_port_marker = lambda: None

probe_error = ""
try:
    module.probe()
except PermissionError as error:
    probe_error = str(error)

sys.argv = [sys.argv[1], "probe"]
exit_code = module.main()
print(json.dumps({"probe_error": probe_error, "exit_code": exit_code}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      probe_error: "Hermes root API port marker is unavailable",
      exit_code: 2,
    });
    expect(result.stderr.trim()).toBe("Hermes root API port marker is unavailable");
  });
});
