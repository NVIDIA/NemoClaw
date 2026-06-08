// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("tunnel --help exits 0 and shows tunnel subcommands", () => {
    const r = run("tunnel --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("root help shows tunnel status with tunnel start and stop", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nemoclaw tunnel start");
    expect(r.out).toContain("nemoclaw tunnel stop");
    expect(r.out).toContain("nemoclaw tunnel status");
  });

  it("tunnel start --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("Start the cloudflared public-URL tunnel");
  });

  it("deprecated start --help exits 0 and shows alias usage", () => {
    const r = run("start --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("start");
    expect(r.out).toContain("Deprecated alias");
  });

  it("tunnel stop --help exits 0 and shows tunnel usage", () => {
    const r = run("tunnel stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("Stop the cloudflared public-URL tunnel");
  });

  it("tunnel status --help exits 0 and shows tunnel status usage", () => {
    const r = run("tunnel status --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel status");
    expect(r.out).toContain("Show cloudflared public-URL tunnel status");
  });

  it("tunnel status exits 0 and prints cloudflared status", () => {
    const r = run("tunnel status");
    expect(r.code).toBe(0);
    expect(r.out).toContain("cloudflared");
  });

  it("bare tunnel exits 0 and shows tunnel subcommands", () => {
    const r = run("tunnel");
    expect(r.code).toBe(0);
    expect(r.out).toContain("tunnel <start|stop|status>");
    expect(r.out).toContain("tunnel start");
    expect(r.out).toContain("tunnel stop");
    expect(r.out).toContain("tunnel status");
  });

  it("deprecated stop --help exits 0 and shows alias usage", () => {
    const r = run("stop --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("stop");
    expect(r.out).toContain("Deprecated alias");
  });

  it("credentials help exits 0 and shows credential subcommands", () => {
    const r = run("credentials --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("$ nemoclaw credentials <list|reset>");
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("credentials reset");
  });

  it("credentials list --help exits 0 and shows list usage", () => {
    const r = run("credentials list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("List provider credentials");
  });

  it("credentials reset without provider uses oclif required-arg validation", () => {
    const r = run("credentials reset --yes");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
  });

  it("maintenance command help exits 0 and shows migrated usage", () => {
    const backup = run("backup-all --help");
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("backup-all");
    expect(backup.out).toContain("Back up all sandbox state before upgrade");

    const upgrade = run("upgrade-sandboxes --help");
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("upgrade-sandboxes [--check] [--auto] [--yes|-y]");
    expect(upgrade.out).toContain("Detect and rebuild stale sandboxes");

    const gc = run("gc --help");
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("gc [--dry-run] [--yes|-y|--force]");
    expect(gc.out).toContain("Remove orphaned sandbox Docker images");
  });

  it("maintenance commands dispatch through oclif", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-maintenance-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "docker"),
      ["#!/bin/sh", "if [ \"$1\" = \"images\" ]; then exit 0; fi", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const backup = runWithEnv("backup-all", { HOME: home });
    expect(backup.code).toBe(0);
    expect(backup.out).toContain("No sandboxes registered. Nothing to back up.");

    const upgrade = runWithEnv("upgrade-sandboxes --check", { HOME: home });
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain("No sandboxes found in the registry.");

    const gc = runWithEnv("gc --dry-run", { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` });
    expect(gc.code).toBe(0);
    expect(gc.out).toContain("No sandbox images found on the host.");
  });

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
