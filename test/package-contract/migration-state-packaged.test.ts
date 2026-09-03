// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createSnapshotBundle,
  detectHostOpenClaw,
  restoreSnapshotToHost,
} from "../../nemoclaw/dist/commands/migration-state.js";

const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true })),
);

test("packaged migration converts and restores external OpenClaw state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migration-home-"));
  homes.push(home);
  const state = path.join(home, "external-state");
  const config = path.join(home, "external-config", "openclaw.json");
  const workspace = path.join(home, "external-workspace");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(state, "state-marker"), "before");
  fs.writeFileSync(path.join(workspace, "workspace-marker"), "before");
  fs.symlinkSync("workspace-marker", path.join(workspace, "workspace-link"));
  fs.writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace } } }));
  Object.assign(process.env, {
    HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
  });
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
  expect(detected).toMatchObject({ exists: true, hasExternalConfig: true });
  const bundle = createSnapshotBundle(detected, logger, { persist: true });
  expect(bundle).not.toBeNull();
  const prepared = JSON.parse(
    fs.readFileSync(path.join(bundle!.preparedStateDir, "openclaw.json"), "utf8"),
  );
  expect(prepared.agents.defaults.workspace).toBe(detected.externalRoots[0].sandboxPath);
  const snapshotWorkspace = path.join(
    bundle!.snapshotDir,
    bundle!.manifest.externalRoots[0].snapshotRelativePath,
  );
  expect(fs.lstatSync(path.join(snapshotWorkspace, "workspace-link")).isSymbolicLink()).toBe(true);
  fs.writeFileSync(path.join(state, "state-marker"), "after");
  fs.writeFileSync(config, "{}");
  expect(restoreSnapshotToHost(bundle!.snapshotDir, logger)).toBe(true);
  expect(fs.readFileSync(path.join(state, "state-marker"), "utf8")).toBe("before");
  expect(JSON.parse(fs.readFileSync(config, "utf8")).agents.defaults.workspace).toBe(workspace);
});
