// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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

  it.runIf(process.platform !== "win32")(
    "fails closed when a parent directory is swapped after the secure read",
    () => {
      const root = makeRoot();
      const outside = makeRoot();
      const wrapperRoot = makeRoot();
      const nested = path.join(root, "nested");
      const movedNested = path.join(root, "nested-before-swap");
      const marker = path.join(wrapperRoot, "swapped");
      const wrapper = path.join(wrapperRoot, "python3");
      const outsideConfig = path.join(outside, "config.json");
      mkdirSync(nested);
      writeFileSync(
        path.join(nested, "config.json"),
        JSON.stringify({ apiKey: "sk-secret-value" }),
      );
      writeFileSync(outsideConfig, JSON.stringify({ apiKey: "outside-must-not-change" }));

      const python = spawnSync(
        "python3",
        ["-I", "-c", "import os, sys; print(os.path.realpath(sys.executable))"],
        { encoding: "utf-8" },
      );
      expect(python.status, python.stderr).toBe(0);
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          `if [ \"\${4-}\" = apply ] && [ ! -e ${shellQuote(marker)} ]; then`,
          `  mv ${shellQuote(nested)} ${shellQuote(movedNested)}`,
          `  ln -s ${shellQuote(outside)} ${shellQuote(nested)}`,
          `  : > ${shellQuote(marker)}`,
          "fi",
          `exec ${shellQuote(python.stdout.trim())} \"$@\"`,
        ].join("\n"),
      );
      chmodSync(wrapper, 0o755);
      vi.stubEnv("PATH", `${wrapperRoot}:${process.env.PATH ?? ""}`);

      expect(() => sanitizeMigrationDirectory(root)).toThrow(
        /Failed to sanitize migration artifacts safely/u,
      );
      expect(readFileSync(outsideConfig, "utf-8")).toBe(
        JSON.stringify({ apiKey: "outside-must-not-change" }),
      );
      expect(readFileSync(path.join(movedNested, "config.json"), "utf-8")).toContain(
        "sk-secret-value",
      );
    },
  );
});
