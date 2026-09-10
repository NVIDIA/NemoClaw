// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSnapshotSanitizerHelperPath,
  setSnapshotSanitizerHelperPathForTest,
} from "../shared/snapshot-sanitizer-boundary.cjs";
import { sanitizeMigrationDirectory, sanitizeOpenClawConfigFile } from "./snapshot-sanitizer.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-sanitizer-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  setSnapshotSanitizerHelperPathForTest(undefined);
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function writeNodeHelperWrapper(beforeForward: readonly string[]): string {
  const wrapperRoot = makeRoot();
  const wrapper = path.join(wrapperRoot, "snapshot-helper.mjs");
  const helper = resolveSnapshotSanitizerHelperPath();
  writeFileSync(
    wrapper,
    [
      'import { readFileSync, renameSync, symlinkSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      ...beforeForward,
      'const input = readFileSync(0, "utf8");',
      `const helper = ${JSON.stringify(helper)};`,
      'const helperArguments = helper.endsWith(".mts") ? ["--import", "tsx", helper, process.argv[2]] : [helper, process.argv[2]];',
      "const result = spawnSync(process.execPath, helperArguments, {",
      '  encoding: "utf8", env: {}, input, maxBuffer: 48 * 1024 * 1024,',
      "});",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "process.exit(result.status ?? 1);",
    ].join("\n"),
  );
  setSnapshotSanitizerHelperPathForTest(wrapper);
  return wrapper;
}

describe("migration snapshot sanitizer", () => {
  it.runIf(process.platform === "darwin")(
    "sanitizes on macOS when the helper drops temporary-directory overrides (#11174)",
    () => {
      const root = makeRoot();
      const configPath = path.join(root, "openclaw.json");
      writeFileSync(configPath, JSON.stringify({ apiKey: "sk-macos-probe-secret", label: "keep" }));
      vi.stubEnv("TMPDIR", path.join(root, "unused-temp-override"));

      expect(sanitizeOpenClawConfigFile(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        apiKey: "[STRIPPED_BY_MIGRATION]",
        label: "keep",
      });
    },
  );

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
    writeFileSync(path.join(root, "notes.txt"), "retained context\n");

    sanitizeMigrationDirectory(root);

    expect(readFileSync(path.join(root, "empty.yaml"), "utf-8")).toBe("");
    expect(readFileSync(path.join(root, "comments.yaml"), "utf-8")).toBe("# retained context\n");
    expect(readFileSync(path.join(root, "notes.txt"), "utf-8")).toBe("retained context\n");
  });

  it("handles required-config path, presence, format, and stable-content boundaries", () => {
    const root = makeRoot();
    expect(sanitizeOpenClawConfigFile(".")).toBe(false);
    expect(sanitizeOpenClawConfigFile(path.join(root, "missing", "openclaw.json"))).toBe(false);
    expect(sanitizeOpenClawConfigFile(path.join(root, "openclaw.json"))).toBe(false);

    const textPath = path.join(root, "openclaw.txt");
    writeFileSync(textPath, "not a supported config format\n");
    expect(sanitizeOpenClawConfigFile(textPath)).toBe(false);

    const safePath = path.join(root, "openclaw.json");
    const safeContent = JSON.stringify({ model: "keep-me" }, null, 2);
    writeFileSync(safePath, safeContent);
    expect(sanitizeOpenClawConfigFile(safePath)).toBe(true);
    expect(readFileSync(safePath, "utf-8")).toBe(safeContent);
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when a parent directory is swapped after the secure read",
    () => {
      const root = makeRoot();
      const outside = makeRoot();
      const nested = path.join(root, "nested");
      const movedNested = path.join(root, "nested-before-swap");
      const outsideConfig = path.join(outside, "config.json");
      mkdirSync(nested);
      writeFileSync(
        path.join(nested, "config.json"),
        JSON.stringify({ apiKey: "sk-secret-value" }),
      );
      writeFileSync(outsideConfig, JSON.stringify({ apiKey: "outside-must-not-change" }));

      writeNodeHelperWrapper([
        "if (process.argv[2] === 'apply') {",
        `  renameSync(${JSON.stringify(nested)}, ${JSON.stringify(movedNested)});`,
        `  symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(nested)});`,
        "}",
      ]);

      expect(() => sanitizeMigrationDirectory(root)).toThrow(/snapshot-mutation-failed/u);
      expect(readFileSync(outsideConfig, "utf-8")).toBe(
        JSON.stringify({ apiKey: "outside-must-not-change" }),
      );
      expect(readFileSync(path.join(movedNested, "config.json"), "utf-8")).toContain(
        "sk-secret-value",
      );
    },
  );
});
