// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("migration snapshot sanitizer", () => {
  it("sanitizes credential-shaped values in every supported external artifact", () => {
    const root = makeRoot();
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ customValue: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
    );
    writeFileSync(path.join(root, "config.yaml"), "api_key: sk-secret-value\nmodel: keep-me\n");
    writeFileSync(
      path.join(root, "service.env"),
      "BENIGN_NAME=Bearer opaque-secret\nLOG_LEVEL=info\n",
    );

    sanitizeMigrationDirectory(root);

    expect(readFileSync(path.join(root, "config.json"), "utf-8")).not.toContain("ghp_");
    expect(readFileSync(path.join(root, "config.yaml"), "utf-8")).not.toContain("sk-secret");
    expect(readFileSync(path.join(root, "config.yaml"), "utf-8")).toContain("model: keep-me");
    expect(readFileSync(path.join(root, "service.env"), "utf-8")).toContain(
      "BENIGN_NAME=[STRIPPED_BY_MIGRATION]",
    );
    expect(readFileSync(path.join(root, "service.env"), "utf-8")).toContain("LOG_LEVEL=info");
  });

  it("sanitizes secret-shaped scalar JSON and preserves benign scalar JSON", () => {
    const root = makeRoot();
    const secretPath = path.join(root, "secret.json");
    const benignPath = path.join(root, "benign.json");
    writeFileSync(secretPath, JSON.stringify("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    writeFileSync(benignPath, JSON.stringify("keep-me"));

    sanitizeMigrationDirectory(root);

    expect(JSON.parse(readFileSync(secretPath, "utf-8"))).toBe("[STRIPPED_BY_MIGRATION]");
    expect(JSON.parse(readFileSync(benignPath, "utf-8"))).toBe("keep-me");
  });

  it.runIf(process.platform !== "win32")(
    "removes sensitive files without following unrelated symlinks",
    () => {
      const root = makeRoot();
      const externalRoot = makeRoot();
      const targetPath = path.join(externalRoot, "target.json");
      const linkPath = path.join(root, "linked.json");
      writeFileSync(path.join(root, "auth.json"), JSON.stringify({ token: "raw" }));
      writeFileSync(targetPath, JSON.stringify({ apiKey: "sk-secret-value" }));
      symlinkSync(targetPath, linkPath);

      sanitizeMigrationDirectory(path.join(root, "missing"));
      sanitizeMigrationDirectory(root);

      expect(() => readFileSync(path.join(root, "auth.json"))).toThrow();
      expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({
        apiKey: "sk-secret-value",
      });
    },
  );

  it("omits malformed optional artifacts", () => {
    const root = makeRoot();
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "broken.json"), '{"apiKey":');
    writeFileSync(path.join(nested, "broken.yaml"), "api_key: [unclosed\n");

    sanitizeMigrationDirectory(root);

    expect(() => readFileSync(path.join(nested, "broken.json"))).toThrow();
    expect(() => readFileSync(path.join(nested, "broken.yaml"))).toThrow();
  });

  it("fails closed for an unparsable required OpenClaw configuration", () => {
    const root = makeRoot();
    const configPath = path.join(root, "openclaw.json");
    writeFileSync(configPath, '{"apiKey":');

    expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a required OpenClaw configuration symlink",
    () => {
      const root = makeRoot();
      const externalRoot = makeRoot();
      const targetPath = path.join(externalRoot, "target.json");
      const configPath = path.join(root, "openclaw.json");
      writeFileSync(targetPath, JSON.stringify({ apiKey: "sk-secret-value" }));
      symlinkSync(targetPath, configPath);

      expect(sanitizeOpenClawConfigFile(configPath)).toBe(false);
      expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual({
        apiKey: "sk-secret-value",
      });
    },
  );

  it("rejects a non-regular required OpenClaw configuration", () => {
    const root = makeRoot();
    expect(sanitizeOpenClawConfigFile(root)).toBe(false);
  });

  it("preserves empty and comment-only YAML artifacts", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "empty.yaml"), "");
    writeFileSync(path.join(root, "comments.yaml"), "# retained context\n");

    sanitizeMigrationDirectory(root);

    expect(readFileSync(path.join(root, "empty.yaml"), "utf-8")).toBe("");
    expect(readFileSync(path.join(root, "comments.yaml"), "utf-8")).toBe("# retained context\n");
  });
});
