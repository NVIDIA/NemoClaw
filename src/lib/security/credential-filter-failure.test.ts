// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({
  noFollowUnavailable: false,
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
  };
});

import {
  sanitizeConfigFile,
  sanitizeEnvFile,
  sanitizeYamlConfigFile,
} from "./credential-filter.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-credential-filter-failure-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  fsControl.noFollowUnavailable = false;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("credential filter no-follow boundary", () => {
  it("fails closed without atomic no-follow support", () => {
    const root = makeRoot();
    const jsonPath = join(root, "openclaw.json");
    const yamlPath = join(root, "config.yaml");
    const envPath = join(root, ".env");
    const jsonSource = JSON.stringify({ apiKey: "sk-secret-value" });
    const yamlSource = "api_key: sk-secret-value\n";
    const envSource = "API_KEY=sk-secret-value\n";
    writeFileSync(jsonPath, jsonSource);
    writeFileSync(yamlPath, yamlSource);
    writeFileSync(envPath, envSource);
    fsControl.noFollowUnavailable = true;

    expect(sanitizeConfigFile(jsonPath)).toBe(false);
    expect(sanitizeYamlConfigFile(yamlPath)).toBe(false);
    expect(sanitizeEnvFile(envPath)).toBe(false);
    expect(readFileSync(jsonPath, "utf-8")).toBe(jsonSource);
    expect(readFileSync(yamlPath, "utf-8")).toBe(yamlSource);
    expect(readFileSync(envPath, "utf-8")).toBe(envSource);
  });
});
