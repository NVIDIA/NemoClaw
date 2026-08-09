// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.dirname(import.meta.dirname);
const DOC = path.join(REPO_ROOT, "docs", "security", "best-practices.mdx");
const text = fs.readFileSync(DOC, "utf-8");
const sectionStart = text.indexOf("### Auto-Pair Client Allowlist");
const sectionEnd = text.indexOf("</AgentOnly>", sectionStart);
const section = text.slice(sectionStart, sectionEnd);

describe("operator.admin manual approval documentation (#5324)", () => {
  it("limits automatic approval to pairing, read, and write scopes (#5324)", () => {
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(section).toContain("`operator.pairing`, `operator.read`, and `operator.write`");
    expect(section).toContain("It never automatically approves `operator.admin`.");
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
    expect(section).toContain("note the exact `requestId` in the failure");
    expect(section).toContain("Find that exact `requestId`");
    expect(section).toContain(
      "Approve only the exact `requestId` emitted by your command and only the client, device, and scopes you expect.",
    );
  });
});
