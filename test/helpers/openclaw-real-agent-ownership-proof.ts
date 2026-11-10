// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "./openclaw-env-fixture.ts";

/** Check generated ownership and routing through the published runtime. */
export function proveRealOpenClawAgentOwnership(dist: string, nodeExecutable: string): void {
  const home = fs.mkdtempSync(path.join(path.dirname(dist), "ownership-proof-"));
  try {
    const configs = [false, true].flatMap((fleet) =>
      [false, true].map((heartbeat) => ({
        fleet,
        heartbeat,
        cfg: buildConfig({
          ...baseOpenClawGenerationEnv(),
          HOME: home,
          NEMOCLAW_INFERENCE_API: "openai-completions",
          ...(heartbeat ? { NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m" } : {}),
          NEMOCLAW_EXTRA_AGENTS_JSON_B64: Buffer.from(
            JSON.stringify(
              fleet
                ? [
                    {
                      id: "research",
                      workspace: "/sandbox/.openclaw/workspace-research",
                      agentDir: "/sandbox/.openclaw/agents/research",
                      tools: { profile: "minimal", allow: ["read"] },
                    },
                  ]
                : [],
            ),
          ).toString("base64"),
        }),
      })),
    );
    const result = spawnSync(nodeExecutable, ["--input-type=module", "-e", PROOF, dist], {
      input: JSON.stringify(configs),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: home,
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /NEMOCLAW_AGENT_OWNERSHIP_PROOF=passed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const PROOF = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dist = process.argv[1];
const files = fs.readdirSync(dist).filter((file) =>
  /^(?:legacy|validation-core|agent-scope-config|resolve-route|heartbeat-config)-.*\.mjs$/.test(file));
const modules = await Promise.all(files.map((file) => import(pathToFileURL(path.join(dist, file)).href)));
function native(name) {
  const matches = [...new Set(modules.flatMap((module) => Object.values(module)
    .filter((value) => typeof value === "function" && value.name === name)))];
  assert.equal(matches.length, 1, "one native " + name);
  return matches[0];
}
for (const { cfg, fleet, heartbeat } of JSON.parse(fs.readFileSync(0, "utf8"))) {
  assert.deepEqual(native("findLegacyConfigIssues")(cfg), []);
  const validation = native("validateConfigObjectRaw")(cfg);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.equal(native("resolveAgentOperationAgentId")(cfg), "main");
  assert.equal(native("resolveAmbientOwnerAgentId")(cfg), "main");
  if (fleet) assert.equal(native("resolveAgentWorkspaceDir")(cfg, "main"), "/sandbox/.openclaw/workspace");
  assert.deepEqual(native("resolveHeartbeatAgentIds")(cfg), fleet && heartbeat ? ["main", "research"] : ["main"]);
  for (const channel of ["telegram", "discord", "slack", "whatsapp", "msteams", "googlechat", "openclaw-weixin"]) {
    assert.equal(native("resolveAgentRoute")({ cfg, channel, accountId: "default", peer: { kind: "direct", id: "fixture-user" } }).agentId, "main");
  }
}
console.log("NEMOCLAW_AGENT_OWNERSHIP_PROOF=passed");
`;
