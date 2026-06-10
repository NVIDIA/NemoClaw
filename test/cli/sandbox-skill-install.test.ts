// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

describe("sandbox skill install CLI dispatch", () => {
  it("shows native skill install help when --help follows install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw sandbox skill install <name> <path>");
    expect(r.out).toContain("Deploy a skill directory");
    expect(r.out).not.toContain("No SKILL.md found");
  });

  it("requires a skill install path before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-missing-path-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install 2>&1", { HOME: home });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("path");
  });

  it("points plugin-shaped directories away from skill install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-plugin-hint-"));
    const pluginDir = path.join(home, "openclaw-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "demo-plugin", openclaw: { extensions: ["./dist/index.js"] } }),
    );

    const r = runWithEnv(`alpha skill install ${JSON.stringify(pluginDir)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found in");
    expect(r.out).toContain("This looks like an OpenClaw plugin");
    expect(r.out).toContain("nemoclaw onboard --from <Dockerfile>");
  });

  it("detects openclaw.plugin.json as a plugin marker", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-plugin-marker-"));
    const pluginDir = path.join(home, "openclaw-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ name: "demo" }),
    );

    const r = runWithEnv(`alpha skill install ${JSON.stringify(pluginDir)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found in");
    expect(r.out).toContain("This looks like an OpenClaw plugin");
    expect(r.out).toContain("nemoclaw onboard --from <Dockerfile>");
  });
});
