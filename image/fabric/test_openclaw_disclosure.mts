// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Exercises the OpenClaw tool factory and catalog from the image pinned in the openclaw Dockerfile stage.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createOpenClawCodingTools } from "/app/dist/agent-tools-CNTtT1Sj.mjs";
import {
  a as applyToolSearchCatalog,
  v as createToolSearchCatalogRef,
} from "/app/dist/local-model-lean-Ct7p3GNL.mjs";
await fs.mkdir("/sandbox/workspace", { recursive: true });
const sentinel = "/sandbox/workspace/disclosure.txt";
await fs.writeFile(sentinel, "disclosure-fixture");
for (const [agentId, disclosure] of [
  ["primary", "direct"],
  ["primary", "progressive"],
  ["reader", "progressive"],
]) {
  const options = {
    api: "openai-completions",
    tuning: {},
    agents: [{ name: agentId, tools: agentId === "reader" ? { allow: ["read"] } : { disclosure } }],
  };
  const config = JSON.parse(
    execFileSync(
      "/opt/fabric/bin/python",
      [
        "-c",
        'import json,sys; from openclaw_adapter import native_configuration; print(json.dumps(native_configuration("primary", json.loads(sys.argv[1]))))',
        JSON.stringify(options),
      ],
      { encoding: "utf8" },
    ),
  );
  const catalogRef = createToolSearchCatalogRef();
  const tools = createOpenClawCodingTools({
    config,
    agentId,
    sessionKey: `agent:${agentId}:fixture`,
    workspaceDir: "/sandbox/workspace",
    cwd: "/sandbox/workspace",
    includeToolSearchControls: true,
    toolSearchCatalogRef: catalogRef,
  });
  const exposed = applyToolSearchCatalog({ config, tools, catalogRef }).tools;
  const names = exposed.map((tool) => tool.name);
  if (disclosure === "direct") {
    assert(!names.includes("tool_search"));
    assert.equal(names.includes("exec"), agentId === "primary");
  } else {
    assert(names.includes("tool_search"), names.join(","));
    const search = exposed.find((tool) => tool.name === "tool_search");
    assert(search);
    const result = await search.execute("find-read", { query: "read" });
    assert(JSON.stringify(result).includes("read"));
    if (agentId === "reader") {
      const call = exposed.find((tool) => tool.name === "tool_call");
      assert(call);
      const read = await call.execute("call-read", { id: "read", args: { path: sentinel } });
      assert(JSON.stringify(read).includes("disclosure-fixture"));
      for (const denied of ["exec", "write", "edit", "sessions_spawn"]) {
        await assert.rejects(() =>
          call.execute("denied", { id: denied, args: { command: "false" } }),
        );
      }
    }
  }

}
assert.equal(await fs.readFile(sentinel, "utf8"), "disclosure-fixture");
console.log("Direct exposure and progressive search/call preserve the read-only allowlist.");
