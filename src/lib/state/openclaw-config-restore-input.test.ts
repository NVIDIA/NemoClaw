// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenClawConfigRestoreInput,
  shouldMergeOpenClawConfigStateFile,
} from "../../../dist/lib/state/openclaw-config-restore-input";

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
});
