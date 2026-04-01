// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTICE_CONFIG_PATH,
  loadOnboardNoticeConfig,
  loadOnboardNoticeState,
  renderOnboardNoticeLines,
  saveOnboardNoticeState,
  shouldShowOnboardNotice,
  showOnboardNoticeIfNeeded,
} from "../bin/lib/onboard-notice";

describe("onboard notice", () => {
  it("loads the bundled notice config", () => {
    const config = loadOnboardNoticeConfig(DEFAULT_NOTICE_CONFIG_PATH);
    expect(config.version).toBeTruthy();
    expect(config.url).toBe("https://docs.nvidia.com/nemoclaw/latest/reference/usage-notice.html");
    expect(renderOnboardNoticeLines(config).join("\n")).toContain(config.summary);
  });

  it("records the last seen notice version", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-notice-state-"));
    const statePath = path.join(tmpDir, "onboard-notice.json");

    saveOnboardNoticeState("2026-04-01", statePath);

    expect(loadOnboardNoticeState(statePath)).toMatchObject({
      lastSeenVersion: "2026-04-01",
    });
  });

  it("shows the notice once in non-interactive mode and writes to stderr", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-notice-show-"));
    const statePath = path.join(tmpDir, "onboard-notice.json");
    const lines = [];

    const first = await showOnboardNoticeIfNeeded({
      nonInteractive: true,
      statePath,
      writeLine: (line) => lines.push(line),
    });
    const second = await showOnboardNoticeIfNeeded({
      nonInteractive: true,
      statePath,
      writeLine: (line) => lines.push(line),
    });

    expect(first).toMatchObject({ shown: true });
    expect(second).toMatchObject({ shown: false });
    expect(lines.join("\n")).toContain("Usage Notice");
    expect(lines.join("\n")).toContain(
      "[non-interactive] Continuing after logging the usage notice.",
    );
  });

  it("warns and continues when notice state cannot be persisted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-notice-unwritable-"));
    const stateParent = path.join(tmpDir, "state");
    const statePath = path.join(stateParent, "onboard-notice.json");
    const lines = [];

    fs.writeFileSync(stateParent, "not a directory");

    const result = await showOnboardNoticeIfNeeded({
      nonInteractive: true,
      statePath,
      writeLine: (line) => lines.push(line),
    });

    expect(result).toMatchObject({ shown: true });
    expect(lines.join("\n")).toContain("Warning: could not persist usage notice state");
    expect(lines.join("\n")).toContain(statePath);
  });

  it("re-shows the notice when the configured version changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-notice-version-"));
    const statePath = path.join(tmpDir, "onboard-notice.json");
    const configPath = path.join(tmpDir, "notice.json");

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: "2026-04-01",
        title: "Usage Notice",
        summary: "First version.",
        details: "Review before continuing:",
        url: "https://example.com/notice",
        prompt: "Continue: ",
      }),
    );
    await showOnboardNoticeIfNeeded({
      nonInteractive: true,
      statePath,
      configPath,
      writeLine: () => {},
    });

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: "2026-05-01",
        title: "Usage Notice",
        summary: "Updated version.",
        details: "Review before continuing:",
        url: "https://example.com/notice",
        prompt: "Continue: ",
      }),
    );

    const shown = await showOnboardNoticeIfNeeded({
      nonInteractive: true,
      statePath,
      configPath,
      writeLine: () => {},
    });

    expect(shown).toMatchObject({ shown: true, version: "2026-05-01" });
  });

  it("blocks in interactive mode until the user acknowledges the notice", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-notice-ack-"));
    const statePath = path.join(tmpDir, "onboard-notice.json");
    const prompts = [];

    const result = await showOnboardNoticeIfNeeded({
      nonInteractive: false,
      statePath,
      promptFn: async (question) => {
        prompts.push(question);
        return "";
      },
      writeLine: () => {},
    });

    expect(result).toMatchObject({ shown: true });
    expect(prompts).toEqual(["  Press Enter to continue onboarding: "]);
  });

  it("tracks whether the current notice version still needs to be shown", () => {
    const config = loadOnboardNoticeConfig(DEFAULT_NOTICE_CONFIG_PATH);
    expect(shouldShowOnboardNotice(config, { lastSeenVersion: null, lastSeenAt: null })).toBe(true);
    expect(
      shouldShowOnboardNotice(config, { lastSeenVersion: config.version, lastSeenAt: null }),
    ).toBe(false);
  });
});
