// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_NEMOCLAW_INSTANCE } from "../../../dist/lib/core/instance";
import {
  BASE_NEMOCLAW_HOME_DIR_NAME,
  ROOT,
  resolveNemoclawHomeDir,
  resolveNemoclawHomeDirName,
  resolveNemoclawStateDir,
  SCRIPTS,
} from "../../../dist/lib/state/paths";

describe("paths", () => {
  it("resolves the repo root", () => {
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(ROOT, "bin", "nemoclaw.js"))).toBe(true);
  });

  it("resolves the scripts directory from the repo root", () => {
    expect(SCRIPTS).toBe(join(ROOT, "scripts"));
    expect(existsSync(join(SCRIPTS, "debug.sh"))).toBe(true);
  });
});

describe("resolveNemoclawHomeDirName", () => {
  it("keeps the bare .nemoclaw leaf for the default instance", () => {
    expect(resolveNemoclawHomeDirName(DEFAULT_NEMOCLAW_INSTANCE)).toBe(BASE_NEMOCLAW_HOME_DIR_NAME);
  });

  it("suffixes the leaf with the instance name for a non-default instance", () => {
    expect(resolveNemoclawHomeDirName("agent-a")).toBe(".nemoclaw-agent-a");
    expect(resolveNemoclawHomeDirName("tenant1")).toBe(".nemoclaw-tenant1");
  });

  it("derives distinct leaves for two different instances", () => {
    const a = resolveNemoclawHomeDirName("agent-a");
    const b = resolveNemoclawHomeDirName("agent-b");
    expect(a).not.toBe(b);
  });
});

describe("resolveNemoclawHomeDir / resolveNemoclawStateDir", () => {
  const home = "/tmp/nemoclaw-instance-fixture";

  it("returns the bare ~/.nemoclaw path for the default instance", () => {
    expect(resolveNemoclawHomeDir(home, DEFAULT_NEMOCLAW_INSTANCE)).toBe(
      join(home, BASE_NEMOCLAW_HOME_DIR_NAME),
    );
    expect(resolveNemoclawStateDir(home, DEFAULT_NEMOCLAW_INSTANCE)).toBe(
      join(home, BASE_NEMOCLAW_HOME_DIR_NAME, "state"),
    );
  });

  it("returns the per-instance home and state dirs for a non-default instance", () => {
    expect(resolveNemoclawHomeDir(home, "agent-a")).toBe(
      join(home, `${BASE_NEMOCLAW_HOME_DIR_NAME}-agent-a`),
    );
    expect(resolveNemoclawStateDir(home, "agent-a")).toBe(
      join(home, `${BASE_NEMOCLAW_HOME_DIR_NAME}-agent-a`, "state"),
    );
  });

  it("segregates two instances under the same home dir", () => {
    expect(resolveNemoclawHomeDir(home, "agent-a")).not.toBe(
      resolveNemoclawHomeDir(home, "agent-b"),
    );
    expect(resolveNemoclawStateDir(home, "agent-a")).not.toBe(
      resolveNemoclawStateDir(home, "agent-b"),
    );
  });
});
