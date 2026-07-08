// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenClawConfigRestoreInput,
  buildOpenClawConfigRestoreInputFromSandbox,
  shouldMergeOpenClawConfigStateFile,
} from "./openclaw-config-restore-input";

function bufferJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe("shouldMergeOpenClawConfigStateFile", () => {
  it("documents the OpenClaw manifest/config-path boundary for selective restore", () => {
    expect(
      shouldMergeOpenClawConfigStateFile("openclaw", "/sandbox/.openclaw", {
        path: "openclaw.json",
        strategy: "copy",
      }),
    ).toBe(true);
    expect(
      shouldMergeOpenClawConfigStateFile("custom", "/sandbox/.openclaw", {
        path: "openclaw.json",
        strategy: "copy",
      }),
    ).toBe(true);
    expect(
      shouldMergeOpenClawConfigStateFile("openclaw", "/sandbox/.openclaw", {
        path: "other.json",
        strategy: "copy",
      }),
    ).toBe(false);
    expect(
      shouldMergeOpenClawConfigStateFile("openclaw", "/sandbox/.openclaw", {
        path: "openclaw.json",
        strategy: "sqlite_backup",
      }),
    ).toBe(false);
  });
});

describe("buildOpenClawConfigRestoreInput", () => {
  it("fails closed when the current rebuilt OpenClaw config is missing", () => {
    const result = buildOpenClawConfigRestoreInput(bufferJson({ mcpServers: {} }), null);

    expect(result).toMatchObject({
      ok: false,
      error: "openclaw.json selective merge requires current rebuilt config",
    });
  });

  it("fails closed instead of wholesale restoring backup on invalid current JSON", () => {
    const result = buildOpenClawConfigRestoreInput(
      bufferJson({ channels: { discord: { token: "stale" } } }),
      Buffer.from("{ invalid json"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("refusing unsafe wholesale backup restore");
    }
  });

  it("fails closed instead of wholesale restoring invalid backup JSON", () => {
    const result = buildOpenClawConfigRestoreInput(
      Buffer.from("{ invalid json"),
      bufferJson({ gateway: { auth: { token: "fresh" } } }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("refusing unsafe wholesale backup restore");
    }
  });

  it("reconciles complete plugin provenance without persisting transient installs", () => {
    const result = buildOpenClawConfigRestoreInput(
      bufferJson({
        plugins: {
          entries: { weather: { enabled: true } },
          installs: { weather: { installPath: "/sandbox/.openclaw/extensions/weather" } },
        },
      }),
      bufferJson({ plugins: { entries: {} } }),
      {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [
          {
            id: "weather",
            installPath: "/sandbox/.openclaw/extensions/weather",
            loadPaths: [],
          },
        ],
      },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? JSON.parse(result.input.toString("utf8")) : null).toEqual({
      plugins: { entries: {} },
    });
  });

  it("fails closed on incomplete plugin provenance", () => {
    const result = buildOpenClawConfigRestoreInput(
      bufferJson({ plugins: { entries: {} } }),
      bufferJson({ plugins: { entries: {} } }),
      {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [
          {
            id: "weather",
            installPath: "/sandbox/.openclaw/extensions/weather",
          },
        ],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing explicit load paths"),
    });
  });
});

describe("buildOpenClawConfigRestoreInputFromSandbox", () => {
  it("identifies incomplete previous image provenance before reading live state (#6108)", () => {
    const result = buildOpenClawConfigRestoreInputFromSandbox({
      backupContents: bufferJson({ plugins: { entries: {} } }),
      dir: "/sandbox/.openclaw",
      freshImagePluginInstalls: [],
      previousImagePluginInstalls: [
        {
          id: "weather",
          installPath: "/sandbox/.openclaw/extensions/weather",
        },
      ],
      specPath: "openclaw.json",
      sshArgs: [],
    });

    expect(result).toEqual({
      ok: false,
      error: "Previous OpenClaw image plugin provenance is incomplete",
    });
  });
});
