// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import {
  createArchiveFromDirectory,
  createSnapshotBundle,
  detectHostOpenClaw,
  restoreSnapshotToHost,
} from "../../nemoclaw/dist/commands/migration-state.js";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
});

test("packaged migration converts and restores external OpenClaw state", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migration-home-"));
  homes.push(home);
  const state = path.join(home, "external-state");
  const config = path.join(home, "external-config", "openclaw.json");
  const workspace = path.join(home, "external-workspace");
  const agentDir = path.join(home, "external-agent");
  const skillsDir = path.join(home, "external-skills");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(state, "state-marker"), "before");
  fs.writeFileSync(path.join(workspace, "workspace-marker"), "before");
  fs.symlinkSync("workspace-marker", path.join(workspace, "workspace-link"));
  fs.writeFileSync(path.join(agentDir, "agent-marker"), "before");
  fs.writeFileSync(path.join(skillsDir, "skill-marker"), "before");
  fs.symlinkSync("skill-marker", path.join(skillsDir, "skill-link"));
  fs.writeFileSync(
    config,
    JSON.stringify({
      agents: { defaults: { workspace }, list: [{ id: "main", agentDir }] },
      skills: { load: { extraDirs: [skillsDir] } },
    }),
  );
  vi.stubEnv("HOME", "");
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", config);
  const messages: string[] = [];
  const logger = {
    debug: (message: string) => messages.push(message),
    info: (message: string) => messages.push(message),
    warn: (message: string) => messages.push(message),
    error: (message: string) => {
      throw new Error(message);
    },
  };
  const detected = detectHostOpenClaw(process.env);
  expect(detected).toMatchObject({ exists: true, hasExternalConfig: true, homeDir: home });
  const bundle = createSnapshotBundle(detected, logger, { persist: true });
  expect(bundle).not.toBeNull();
  const prepared = JSON.parse(
    fs.readFileSync(path.join(bundle!.preparedStateDir, "openclaw.json"), "utf8"),
  );
  const rootsByKind = Object.fromEntries(
    detected.externalRoots.map((root) => [root.kind, root]),
  ) as Record<string, (typeof detected.externalRoots)[number]>;
  expect(prepared.agents.defaults.workspace).toBe(rootsByKind.workspace.sandboxPath);
  expect(prepared.agents.list[0].agentDir).toBe(rootsByKind.agentDir.sandboxPath);
  expect(prepared.skills.load.extraDirs).toEqual([rootsByKind.skillsExtraDir.sandboxPath]);
  const snapshotWorkspace = path.join(
    bundle!.snapshotDir,
    rootsByKind.workspace.snapshotRelativePath,
  );
  const snapshotSkills = path.join(
    bundle!.snapshotDir,
    rootsByKind.skillsExtraDir.snapshotRelativePath,
  );
  expect(fs.lstatSync(path.join(snapshotWorkspace, "workspace-link")).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(path.join(snapshotSkills, "skill-link")).isSymbolicLink()).toBe(true);
  const archive = path.join(bundle!.archivesDir, "migration-state.tgz");
  const extracted = path.join(home, "extracted-archive");
  await createArchiveFromDirectory(bundle!.snapshotDir, archive);
  fs.mkdirSync(extracted);
  const extraction = spawnSync("tar", ["-xf", archive, "-C", extracted], { encoding: "utf8" });
  expect(extraction.status, extraction.stderr).toBe(0);
  expect(
    fs
      .lstatSync(path.join(extracted, rootsByKind.workspace.snapshotRelativePath, "workspace-link"))
      .isSymbolicLink(),
  ).toBe(true);
  expect(
    fs
      .lstatSync(
        path.join(extracted, rootsByKind.skillsExtraDir.snapshotRelativePath, "skill-link"),
      )
      .isSymbolicLink(),
  ).toBe(true);
  fs.writeFileSync(path.join(state, "state-marker"), "after");
  fs.writeFileSync(config, "{}");
  expect(restoreSnapshotToHost(bundle!.snapshotDir, logger)).toBe(true);
  expect(fs.readFileSync(path.join(state, "state-marker"), "utf8")).toBe("before");
  const restored = JSON.parse(fs.readFileSync(config, "utf8"));
  expect(restored.agents.defaults.workspace).toBe(workspace);
  expect(restored.agents.list[0].agentDir).toBe(agentDir);
  expect(restored.skills.load.extraDirs).toEqual([skillsDir]);
  expect(fs.lstatSync(path.join(skillsDir, "skill-link")).isSymbolicLink()).toBe(true);
});
