// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listAgents, loadAgent } from "./defs";
import {
  buildStateLockPlan,
  readStateDirectories,
  stateDirectoryPaths,
  stateDirectoryPrefixes,
} from "./state-directory-contract";

describe("agent state directory contract", () => {
  it("derives independent backup and Shields projections from one declaration (#8006)", () => {
    const directories = readStateDirectories({
      state_dirs: [
        "history",
        { path: "identity", backup: false, shields: "confidential" },
        {
          path: "agents",
          shields: "read-only",
          writable_subpaths: ["*/sessions"],
        },
        { prefix: "agents-", backup: false, shields: "read-only" },
      ],
    });

    expect(stateDirectoryPaths(directories)).toEqual(["history", "identity", "agents"]);
    expect(stateDirectoryPaths(directories, { backup: true })).toEqual(["history", "agents"]);
    expect(stateDirectoryPaths(directories, { backup: false })).toEqual(["identity"]);
    expect(stateDirectoryPrefixes(directories)).toEqual(["agents-"]);
    expect(stateDirectoryPrefixes(directories, { backup: false })).toEqual(["agents-"]);
    expect(buildStateLockPlan(directories)).toEqual({
      version: 1,
      readOnlyRoots: ["agents"],
      confidentialRoots: ["identity"],
      readOnlyPrefixes: ["agents-"],
      confidentialPrefixes: [],
      writableSubpaths: ["agents/*/sessions"],
    });
  });

  it("keeps OpenClaw machine-local authentication state out of snapshots (#6852)", () => {
    const agent = loadAgent("openclaw");

    expect(agent.nonBackupStateDirs).toEqual(["plugins", "profiles", "identity", "devices"]);
    expect(agent.backupStateDirs).not.toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices"]),
    );
    expect(agent.stateDirs).toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices"]),
    );
  });

  it("preserves the existing Hermes hooks lock without adding it to snapshots (#8006)", () => {
    const agent = loadAgent("hermes");

    expect(agent.stateLockPlan.readOnlyRoots).toContain("hooks");
    expect(agent.nonBackupStateDirs).toContain("hooks");
  });

  it("normalizes nested DCode declarations to protected top-level roots (#8006)", () => {
    expect(loadAgent("langchain-deepagents-code").stateLockPlan).toEqual({
      version: 1,
      readOnlyRoots: ["agent", "skills"],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    });
  });

  it.each([
    {
      agentName: "openclaw",
      expectedPlan: {
        version: 1,
        readOnlyRoots: [
          "agents",
          "canvas",
          "cron",
          "devices",
          "extensions",
          "hooks",
          "memory",
          "plugins",
          "profiles",
          "skills",
          "telegram",
          "wechat",
          "whatsapp",
          "workspace",
        ],
        confidentialRoots: ["credentials", "identity"],
        readOnlyPrefixes: ["workspace-"],
        confidentialPrefixes: [],
        writableSubpaths: ["agents/*/sessions"],
      },
      expectedMutablePaths: [],
    },
    {
      agentName: "hermes",
      expectedPlan: {
        version: 1,
        readOnlyRoots: [
          "cron",
          "hooks",
          "platforms",
          "plugins",
          "profiles",
          "skills",
          "skins",
          "weixin",
          "workspace",
        ],
        confidentialRoots: ["pairing"],
        readOnlyPrefixes: [],
        confidentialPrefixes: [],
        writableSubpaths: ["profiles/dashboard-home"],
      },
      expectedMutablePaths: [
        "memories",
        "sessions",
        "scripts",
        "logs",
        "plans",
        "cache",
        "dashboard-home",
      ],
    },
  ])("pins the complete shipped $agentName Shields boundary (#8006)", (testCase) => {
    const agent = loadAgent(testCase.agentName);

    expect(agent.stateLockPlan).toEqual(testCase.expectedPlan);
    expect(
      agent.stateDirectories.flatMap((entry) =>
        entry.kind === "path" && entry.shields === undefined ? [entry.path] : [],
      ),
    ).toEqual(testCase.expectedMutablePaths);
  });

  // source-shape-contract: security -- Generated image plans must match the reviewed AgentDefinition projection
  it("keeps generated image plans equal to their AgentDefinition projections (#8006)", () => {
    const imagePlanAgents = listAgents().filter(
      (agentName) => loadAgent(agentName).stateLockPlanInImage,
    );
    for (const agentName of imagePlanAgents) {
      const generated = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), "agents", agentName, "state-lock-plan.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const { $comment, ...plan } = generated;

      expect(typeof $comment).toBe("string");
      expect(plan).toEqual(loadAgent(agentName).stateLockPlan);
    }
  });

  it.each([
    [{ state_dirs: "state" }, /state_dirs.*array/],
    [{ state_dirs: ["../state"] }, /canonical relative path/],
    [{ state_dirs: [{ path: "/state" }] }, /relative path/],
    [{ state_dirs: [{ path: "state", prefix: "state-" }] }, /exactly one/],
    [{ state_dirs: [{ path: "state", unknown: true }] }, /unknown.*not allowed/],
    [{ state_dirs: [{ path: "state", backup: "yes" }] }, /backup.*boolean/],
    [
      { state_dirs: [{ path: "state", writable_subpaths: ["runtime"] }] },
      /requires shields: read-only/,
    ],
    [
      {
        state_dirs: [{ path: "state", shields: "read-only", writable_subpaths: ["run*"] }],
      },
      /complete path component/,
    ],
    [
      {
        state_dirs: [{ path: "state", shields: "read-only", writable_subpaths: ["*"] }],
      },
      /literal directory name/,
    ],
    [
      {
        state_dirs: [{ path: "state", shields: "read-only", writable_subpaths: ["runtime/*"] }],
      },
      /literal directory name/,
    ],
    [{ state_dirs: ["state", "state"] }, /repeats path:state/],
    [{ state_dirs: [{ path: "state" }, { prefix: "other-" }] }, /must extend a declared/],
  ])("rejects an invalid state declaration %# (#8006)", (record, expected) => {
    expect(() => readStateDirectories(record)).toThrow(expected);
  });

  it("rejects conflicting Shields policies for one top-level root (#8006)", () => {
    const directories = readStateDirectories({
      state_dirs: [
        { path: "agent/skills", shields: "read-only" },
        { path: "agent/secrets", shields: "confidential" },
      ],
    });

    expect(() => buildStateLockPlan(directories)).toThrow(/root 'agent'.*conflicting/);
  });

  it.each([
    [[{ path: "state dir", shields: "read-only" }], /root 'state dir'.*cannot be represented/],
    [
      [
        { path: "workspace", shields: "read-only" },
        { prefix: "workspace-", shields: "read-only" },
        { path: "workspace-dev", backup: false },
      ],
      /prefix 'workspace-'.*overlaps exact path 'workspace-dev'/,
    ],
    [
      [
        {
          path: "agents",
          shields: "read-only",
          writable_subpaths: ["*/sessions", "main/sessions"],
        },
      ],
      /writable subpaths.*overlap/,
    ],
  ])("rejects a state plan the runtime helper cannot consume %# (#8006)", (stateDirs, expected) => {
    expect(() => buildStateLockPlan(readStateDirectories({ state_dirs: stateDirs }))).toThrow(
      expected,
    );
  });
});
