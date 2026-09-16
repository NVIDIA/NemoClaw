// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Executes the tool factory from the OpenClaw image pinned in the openclaw Dockerfile stage.
// Run only in an isolated fixture container with /sandbox owned by that container.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createOpenClawCodingTools } from "/app/dist/agent-tools-CNTtT1Sj.mjs";
const options = {
  api: "openai-completions",
  tuning: {},
  agents: [
    { name: "primary" },
    { name: "reader", tools: { allow: ["read"] } },
    { name: "reviewer", tools: { allow: ["read"] } },
  ],
};
const config = JSON.parse(
  execFileSync(
    "/opt/fabric/bin/python",
    [
      "-c",
      'import json; from openclaw_adapter import native_configuration; print(json.dumps(native_configuration("primary", json.loads(__import__("sys").argv[1]))))',
      JSON.stringify(options),
    ],
    { encoding: "utf8" },
  ),
);
await fs.mkdir("/sandbox/workspace", { recursive: true });
const sentinel = "/sandbox/workspace/sentinel.txt";
await fs.writeFile(sentinel, "owned-read-fixture");
for (const agentId of ["reader", "primary", "reviewer"]) {
  const tools = createOpenClawCodingTools({
    config,
    agentId,
    sessionKey: `agent:${agentId}:fixture`,
    workspaceDir: "/sandbox/workspace",
    cwd: "/sandbox/workspace",
  });
  const names = tools.map((tool) => tool.name);
  if (agentId === "primary") {
    assert(names.includes("exec"), names.join(","));
  } else {
    assert.deepEqual(names, ["read"]);
    const read = tools.find((tool) => tool.name === "read");
    assert(read);
    const result = await read.execute("fixture-read", { path: sentinel });
    assert(JSON.stringify(result).includes("owned-read-fixture"));
    for (const denied of [
      "write",
      "edit",
      "exec",
      "apply_patch",
      "sessions_spawn",
      "tool_search",
      "tool_call",
    ]) {
      assert.equal(
        tools.find((tool) => tool.name === denied),
        undefined,
      );
    }
  }
}
assert.equal(await fs.readFile(sentinel, "utf8"), "owned-read-fixture");
console.log(
  "Native OpenClaw: three agents, isolated tool catalogs, read execution, no write/exec/delegation tools.",
);
