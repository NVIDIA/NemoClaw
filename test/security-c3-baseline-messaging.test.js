// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: C-3 — Telegram and Discord must NOT appear
// in the baseline sandbox policy.
//
// Messaging APIs are data exfiltration channels. Any process in the sandbox
// can POST arbitrary data when these hosts are listed in the baseline without
// a binaries: restriction. They must be opt-in only (via preset apply).

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE = path.join(
  __dirname, "..", "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml",
);
const PRESETS_DIR = path.join(
  __dirname, "..", "nemoclaw-blueprint", "policies", "presets",
);

// ═══════════════════════════════════════════════════════════════════
// 1. Baseline must NOT contain messaging endpoints
// ═══════════════════════════════════════════════════════════════════
describe("C-3: baseline policy must not contain messaging exfiltration channels", () => {
  it("api.telegram.org does not appear in baseline YAML", () => {
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    assert.ok(
      !yaml.includes("api.telegram.org"),
      "api.telegram.org must not appear in baseline — use the telegram preset instead",
    );
  });

  it("discord.com does not appear in baseline YAML", () => {
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    assert.ok(
      !yaml.includes("discord.com"),
      "discord.com must not appear in baseline — use the discord preset instead",
    );
  });

  it("gateway.discord.gg does not appear in baseline YAML", () => {
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    assert.ok(
      !yaml.includes("gateway.discord.gg"),
      "gateway.discord.gg must not appear in baseline — use the discord preset instead",
    );
  });

  it("cdn.discordapp.com does not appear in baseline YAML", () => {
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    assert.ok(
      !yaml.includes("cdn.discordapp.com"),
      "cdn.discordapp.com must not appear in baseline — use the discord preset instead",
    );
  });

  it("no baseline network_policies block lacks a binaries: restriction", () => {
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    const lines = yaml.split("\n");
    let inNetworkPolicies = false;
    let currentBlock = null;
    const blocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^network_policies:/.test(line)) { inNetworkPolicies = true; continue; }
      if (inNetworkPolicies && /^\S/.test(line) && line.trim() !== "") {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
        inNetworkPolicies = false;
        continue;
      }
      if (!inNetworkPolicies) continue;
      if (/^ {2}(?!#)\S.*:\s*$/.test(line)) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { name: line.trim().replace(/:$/, ""), startLine: i + 1, lines: [line] };
        continue;
      }
      if (currentBlock) currentBlock.lines.push(line);
    }
    if (currentBlock) blocks.push(currentBlock);

    assert.ok(blocks.length > 0, "baseline must have at least one network_policies block");

    const violators = blocks.filter(
      (b) => !b.lines.some((l) => /^\s+binaries:/.test(l)),
    );

    assert.deepEqual(
      violators.map((b) => b.name),
      [],
      `Baseline blocks without binaries: restriction (any sandbox process can reach them):\n` +
        violators.map((b) => `  - ${b.name} (line ${b.startLine})`).join("\n") +
        `\nEither add binaries: or move to opt-in presets.`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Opt-in presets must exist
// ═══════════════════════════════════════════════════════════════════
describe("C-3: messaging presets exist as opt-in path", () => {
  it("telegram.yaml preset exists and contains api.telegram.org", () => {
    const presetPath = path.join(PRESETS_DIR, "telegram.yaml");
    assert.ok(fs.existsSync(presetPath), "telegram.yaml preset must exist");
    const content = fs.readFileSync(presetPath, "utf-8");
    assert.ok(content.includes("api.telegram.org"), "telegram.yaml must include api.telegram.org");
    assert.ok(content.includes("network_policies:"), "telegram.yaml must include network_policies:");
  });

  it("discord.yaml preset exists and contains discord.com", () => {
    const presetPath = path.join(PRESETS_DIR, "discord.yaml");
    assert.ok(fs.existsSync(presetPath), "discord.yaml preset must exist");
    const content = fs.readFileSync(presetPath, "utf-8");
    assert.ok(content.includes("discord.com"), "discord.yaml must include discord.com");
    assert.ok(content.includes("network_policies:"), "discord.yaml must include network_policies:");
  });
});
