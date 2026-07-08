// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");

describe("onboard managed MCP recreation redirect", () => {
  it("prints the explicit observability opt-out in the transactional rebuild command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-observability-redirect-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "redirect.js");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const mocksPath = JSON.stringify(
      path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
    );
    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const normalize = (command) => (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
runner.run = () => ({ status: 0 });
runner.runCapture = (command) => {
  const value = normalize(command);
  if (value.includes("sandbox get alpha")) return "alpha";
  if (value.includes("sandbox list")) return "alpha Ready";
  const mocked = require(${mocksPath}).mockOnboardRunCapture(command, { defaultCurlOutput: "ok" });
  return mocked === null ? "" : mocked;
};
registry.getSandbox = () => ({
  name: "alpha",
  agent: "langchain-deepagents-code",
  model: "model",
  provider: "provider",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "progressive",
  observabilityEnabled: true,
  mcp: {
    version: 1,
    bridges: {
      search: {
        server: "search",
        agent: "langchain-deepagents-code",
        url: "https://mcp.example.test",
        env: [],
        policyName: "mcp-bridge-search",
        addedAt: "2026-07-07T00:00:00.000Z"
      }
    }
  }
});
registry.getDefault = () => null;
const { createSandbox } = require(${onboardPath});
createSandbox(
  null, "model", "provider", "openai-completions", "alpha", null, null, null,
  { name: "langchain-deepagents-code" }, null, null, null, [], null,
  {
    recreate: true,
    toolDisclosure: "progressive",
    observabilityEnabled: false,
    observabilityRequestedExplicitly: true
  }
).then(() => process.exit(91)).catch((error) => { console.error(error); process.exit(92); });
`;
    fs.writeFileSync(scriptPath, script);

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
        },
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Refusing the generic onboard recreation path/);
      assert.match(
        result.stderr,
        /nemoclaw alpha rebuild --yes --tool-disclosure progressive --no-observability/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
