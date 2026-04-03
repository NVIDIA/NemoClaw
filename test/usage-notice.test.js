// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..");
const noticePath = path.join(repoRoot, "bin", "lib", "usage-notice.js");
const {
  NOTICE_ACCEPT_FLAG,
  ensureUsageNoticeConsent,
  formatTerminalHyperlink,
  getUsageNoticeStateFile,
  hasAcceptedUsageNotice,
  loadUsageNoticeConfig,
  printUsageNotice,
} = require(noticePath);

describe("usage notice", () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalHome = process.env.HOME;
  let testHome = null;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(import.meta.dirname, "usage-notice-home-"));
    process.env.HOME = testHome;
    try {
      fs.rmSync(getUsageNoticeStateFile(), { force: true });
    } catch {
      // ignore cleanup errors
    }
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (testHome) {
      fs.rmSync(testHome, { force: true, recursive: true });
      testHome = null;
    }
  });

  it("requires the non-interactive acceptance flag", async () => {
    const lines = [];
    const ok = await ensureUsageNoticeConsent({
      nonInteractive: true,
      acceptedByFlag: false,
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain(NOTICE_ACCEPT_FLAG);
  });

  it("records acceptance in non-interactive mode when the flag is present", async () => {
    const config = loadUsageNoticeConfig();
    const ok = await ensureUsageNoticeConsent({
      nonInteractive: true,
      acceptedByFlag: true,
      writeLine: () => {},
    });

    expect(ok).toBe(true);
    expect(hasAcceptedUsageNotice(config.version)).toBe(true);
  });

  it("cancels interactive onboarding unless the user types yes", async () => {
    const lines = [];
    const ok = await ensureUsageNoticeConsent({
      nonInteractive: false,
      promptFn: async () => "no",
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("Installation cancelled");
  });

  it("records interactive acceptance when the user types yes", async () => {
    const config = loadUsageNoticeConfig();
    const ok = await ensureUsageNoticeConsent({
      nonInteractive: false,
      promptFn: async () => "yes",
      writeLine: () => {},
    });

    expect(ok).toBe(true);
    expect(hasAcceptedUsageNotice(config.version)).toBe(true);
  });

  it("fails interactive mode without a tty", async () => {
    const lines = [];
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    const ok = await ensureUsageNoticeConsent({
      nonInteractive: false,
      promptFn: async () => "yes",
      writeLine: (line) => lines.push(line),
    });

    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("Interactive onboarding requires a TTY");
  });

  it("renders url lines as terminal hyperlinks when tty output is available", () => {
    const lines = [];
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStderrIsTTY = process.stderr.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: true,
      });

      printUsageNotice(loadUsageNoticeConfig(), (line) => lines.push(line));
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutIsTTY,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: originalStderrIsTTY,
      });
    }

    expect(lines.join("\n")).toContain(
      formatTerminalHyperlink(
        "https://docs.openclaw.ai/gateway/security",
        "https://docs.openclaw.ai/gateway/security",
      ),
    );
    expect(lines.join("\n")).toContain("https://docs.openclaw.ai/gateway/security");
  });
});
