// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "../../..", "scripts", "managed-gateway-control.py");

const SAME_NAMESPACE_HARNESS = String.raw`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("managed_control_namespace", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

setns_calls = []
control.os.setns = lambda *_args: setns_calls.append(True)
control._http_healthy = lambda *_args: True
with control.ProcReader() as reader:
    identity = reader.capture(os.getpid())
    result = control._http_healthy_in_gateway_namespace(reader, identity, 18642, "/health")

print(json.dumps([result, len(setns_calls)]))
`;

it.runIf(process.platform === "linux")(
  "probes directly when controller and gateway share a network namespace",
  () => {
    const result = spawnSync("python3", ["-c", SAME_NAMESPACE_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, 0]);
  },
);
