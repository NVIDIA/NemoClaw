// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused coverage for the `--agents <agents.yaml>` lifecycle on `onboard`:
// parse-arg-into-option, missing-path/value rejection, env-var application
// before runOnboard is invoked. Split from legacy-command.test.ts so the
// hotspot does not grow further.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseOnboardArgs, runOnboardCommand } from "./legacy-command";

function exitWithCode(code: number): never {
  throw new Error(String(code));
}

function exitWithPrefixedCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboard --agents", () => {
  it("parses --agents <agents.yaml> into agentsManifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-parse-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");

    const result = parseOnboardArgs(
      ["--agents", manifestPath],
      "--yes-i-accept-third-party-software",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      {
        env: {},
        error: () => {},
        exit: exitWithCode,
      },
    );
    expect(result.agentsManifest).toBe(manifestPath);
  });

  it("rejects --agents when the file is missing", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--agents", "/nonexistent/agents.yaml"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--agents path not found");
  });

  it("rejects --agents when the value is missing", () => {
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--agents"],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--agents requires a path to a YAML manifest");
  });

  it("rejects --agents when --agent is set to a non-OpenClaw runtime", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-hermes-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");
    const errors: string[] = [];
    expect(() =>
      parseOnboardArgs(
        ["--agent", "hermes", "--agents", manifestPath],
        "--yes-i-accept-third-party-software",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithPrefixedCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--agents is OpenClaw-specific");
  });

  it("sets NEMOCLAW_EXTRA_AGENTS_JSON before invoking runOnboard when --agents is supplied", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-env-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(
      manifestPath,
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const previous = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    let observedRaw: string | undefined;
    const runOnboard = vi.fn(async () => {
      observedRaw = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    });
    try {
      await runOnboardCommand({
        args: ["--agents", manifestPath],
        noticeAcceptFlag: "--yes-i-accept-third-party-software",
        noticeAcceptEnv: "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        env: {},
        runOnboard,
        error: () => {},
        exit: exitWithCode,
      });
      expect(observedRaw).toBeDefined();
      const payload = JSON.parse(observedRaw as string);
      expect(payload.agents).toHaveLength(1);
      expect(payload.agents[0]).toMatchObject({
        id: "alpha",
        workspace: "/sandbox/.openclaw/workspace-alpha",
        agentDir: "/sandbox/.openclaw/agents/alpha",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
      } else {
        process.env.NEMOCLAW_EXTRA_AGENTS_JSON = previous;
      }
    }
  });
});
