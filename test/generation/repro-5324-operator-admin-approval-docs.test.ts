// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(REPO_ROOT, "docs", "security", "gateway-authentication-controls.mdx");
const TROUBLESHOOTING_DOC = path.join(REPO_ROOT, "docs", "reference", "troubleshooting.mdx");
const text = fs.readFileSync(DOC, "utf-8");
const troubleshootingText = fs.readFileSync(TROUBLESHOOTING_DOC, "utf-8");
const sectionStart = text.indexOf("## Auto-Pair Client Allowlist");
const sectionEnd = text.indexOf("</AgentOnly>", sectionStart);
const section = text.slice(sectionStart, sectionEnd);
const troubleshootingSectionStart = troubleshootingText.indexOf(
  "### An `openclaw` command inside the sandbox fails with `scope upgrade pending approval`",
);
const troubleshootingSectionEnd = troubleshootingText.indexOf(
  "</AgentOnly>",
  troubleshootingSectionStart,
);
const troubleshootingSection = troubleshootingText.slice(
  troubleshootingSectionStart,
  troubleshootingSectionEnd,
);

describe("operator.admin manual approval documentation (#5324)", () => {
  it("limits automatic approval to pairing, read, and write scopes (#5324)", () => {
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(section).toContain("`operator.pairing`, `operator.read`, and `operator.write`");
    expect(section).toContain("It never automatically approves `operator.admin`.");
    expect(section).toContain("bounded, best-effort approval attempts");
    expect(section).toContain("If an allowlisted request remains pending");
    expect(section).toContain(
      "../reference/troubleshooting#an-openclaw-command-inside-the-sandbox-fails-with-scope-upgrade-pending-approval",
    );
    expect(section).toContain(
      "Unknown clients and non-allowlisted scopes are never automatically approved.",
    );
    expect(section).not.toContain("No action needed.");
    expect(section).toMatch(/cron/i);
  });

  it("documents the bounded manual approval flow in order (#5324)", () => {
    const connect = section.indexOf("$$nemoclaw <name> connect");
    const list = section.indexOf("openclaw devices list --json");
    const approve = section.indexOf("openclaw devices approve <requestId>");
    const retry = section.indexOf("Retry the original administrative command");

    expect(connect).toBeGreaterThanOrEqual(0);
    expect(list).toBeGreaterThan(connect);
    expect(approve).toBeGreaterThan(list);
    expect(retry).toBeGreaterThan(approve);
    expect(section).toContain("note the `requestId` in the failure");
    expect(section).toContain("Find that `requestId`");
    expect(section).toContain(
      "Approve only the `requestId` emitted by your command and only the client, device, and scopes you expect.",
    );
  });

  it("routes troubleshooting approval through the prepared connect shell (#5324)", () => {
    const connect = troubleshootingSection.indexOf("$$nemoclaw <name> connect");
    const list = troubleshootingSection.indexOf("openclaw devices list --json");
    const approve = troubleshootingSection.indexOf("openclaw devices approve <requestId>");

    expect(troubleshootingSectionStart).toBeGreaterThanOrEqual(0);
    expect(troubleshootingSectionEnd).toBeGreaterThan(troubleshootingSectionStart);
    expect(connect).toBeGreaterThanOrEqual(0);
    expect(list).toBeGreaterThan(connect);
    expect(approve).toBeGreaterThan(list);
    expect(troubleshootingSection).toContain("$$nemoclaw <name> connect");
    expect(troubleshootingSection).toContain(
      "Replace `<name>` with the sandbox name from the failed command.",
    );
    expect(troubleshootingSection).toContain("Record the `requestId` from this native failure.");
    expect(troubleshootingSection).toMatch(
      /`connect` makes a bounded, best-effort\s+attempt to settle pending requests/,
    );
    expect(troubleshootingSection).toMatch(/an eligible\s+request can remain\s+pending/);
    expect(troubleshootingSection).not.toContain("`connect` automatically settles");
    expect(troubleshootingSection).toContain("does not authenticate that client metadata");
    expect(troubleshootingSection).not.toMatch(
      /authenticated device\s+identity|authoritative\s+device-identity binding/,
    );
    expect(troubleshootingSection).toMatch(
      /`exec` command streams the native command output and normally returns its\s+native exit status/,
    );
    expect(troubleshootingSection).toMatch(
      /If required post-command OpenClaw permission cleanup fails,\s+`exec` returns 1/,
    );
    expect(troubleshootingSection).toMatch(
      /OpenClaw permission cleanup failed \(command exit\s+<code>; cleanup exit 1\)/,
    );
    expect(troubleshootingSection).not.toContain(
      "The `exec` command preserves the native command output and exit status.",
    );
    expect(troubleshootingSection).toContain(
      "whose `requestId` exactly matches the native failure",
    );
    expect(troubleshootingSection).toContain("approve only that same `requestId`");
    expect(troubleshootingSection).not.toContain("exec -- openclaw devices approve");
  });
});
