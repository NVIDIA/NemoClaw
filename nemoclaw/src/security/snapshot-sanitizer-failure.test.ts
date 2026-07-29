// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({
  failOpenNames: [] as string[],
  preventRemoval: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    constants: { ...original.constants, O_NOFOLLOW: undefined },
    openSync: (target: Parameters<typeof original.openSync>[0], flags: number) => {
      if (fsControl.failOpenNames.some((name) => String(target).endsWith(name))) {
        throw new Error(`simulated open failure: ${String(target)}`);
      }
      return original.openSync(target, flags);
    },
    rmSync: (target: Parameters<typeof original.rmSync>[0], options?: { force?: boolean }) => {
      if (fsControl.preventRemoval && String(target).endsWith("auth.json")) return;
      original.rmSync(target, options);
    },
  };
});

import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-failure-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  fsControl.failOpenNames = [];
  fsControl.preventRemoval = false;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("migration snapshot sanitizer fallbacks", () => {
  it("validates a regular file when O_NOFOLLOW is unavailable", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-secret-value" }));

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      apiKey: "[STRIPPED_BY_MIGRATION]",
    });
  });

  it("rejects a symlink when O_NOFOLLOW is unavailable", () => {
    const root = makeRoot();
    const targetPath = path.join(root, "target.json");
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(targetPath, JSON.stringify({ apiKey: "sk-secret-value" }));
    try {
      symlinkSync(targetPath, configPath);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: string }).code : "";
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({
      apiKey: "sk-secret-value",
    });
  });

  it("fails closed when a sensitive artifact cannot be removed", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "auth.json"), JSON.stringify({ token: "raw" }));
    fsControl.preventRemoval = true;

    expect(() => sanitizeMigrationDirectory(root)).toThrow(
      /Unable to remove unsanitizable migration artifact/u,
    );
  });

  it("omits YAML and env artifacts that cannot be opened safely", () => {
    const root = makeRoot();
    const yamlPath = path.join(root, "blocked.yaml");
    const envPath = path.join(root, "blocked.env");
    writeFileSync(yamlPath, "model: keep-me\n");
    writeFileSync(envPath, "MODEL=keep-me\n");
    fsControl.failOpenNames = ["blocked.yaml", "blocked.env"];

    sanitizeMigrationDirectory(root);

    expect(() => readFileSync(yamlPath)).toThrow();
    expect(() => readFileSync(envPath)).toThrow();
  });
});
