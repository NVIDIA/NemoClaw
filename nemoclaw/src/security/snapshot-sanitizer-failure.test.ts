// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({
  failOpenNames: [] as string[],
  failWriteNames: [] as string[],
  noFollowUnavailable: false,
  preventRemoval: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    constants: {
      ...original.constants,
      get O_NOFOLLOW(): number | undefined {
        return fsControl.noFollowUnavailable ? undefined : original.constants.O_NOFOLLOW;
      },
    },
    openSync: (target: Parameters<typeof original.openSync>[0], flags: number) => {
      switch (fsControl.failOpenNames.some((name) => String(target).endsWith(name))) {
        case true:
          throw new Error(`simulated open failure: ${String(target)}`);
        default:
          return original.openSync(target, flags);
      }
    },
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      const [target] = args;
      switch (fsControl.preventRemoval && String(target).endsWith("auth.json")) {
        case true:
          return;
        default:
          return original.rmSync(...args);
      }
    },
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      const [target] = args;
      switch (fsControl.failWriteNames.some((name) => String(target).includes(name))) {
        case true:
          throw new Error(`simulated write failure: ${String(target)}`);
        default:
          return original.writeFileSync(...args);
      }
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
  fsControl.failWriteNames = [];
  fsControl.noFollowUnavailable = false;
  fsControl.preventRemoval = false;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("migration snapshot sanitizer fallbacks", () => {
  it("fails closed for a regular file when O_NOFOLLOW is unavailable", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-secret-value" }));
    fsControl.noFollowUnavailable = true;

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      apiKey: "sk-secret-value",
    });
  });

  it.runIf(process.platform !== "win32")("rejects a symlink when O_NOFOLLOW is unavailable", () => {
    const root = makeRoot();
    const targetPath = path.join(root, "target.json");
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(targetPath, JSON.stringify({ apiKey: "sk-secret-value" }));
    symlinkSync(targetPath, configPath);
    fsControl.noFollowUnavailable = true;

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({
      apiKey: "sk-secret-value",
    });
  });

  it("fails closed when a required sanitized file cannot be written", () => {
    const configPath = path.join(makeRoot(), "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-secret-value" }));
    fsControl.failWriteNames = ["openclaw.json"];

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
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
