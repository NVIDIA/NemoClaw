// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCanonicalSkillAddCommand,
  buildCanonicalSkillRemoveCommand,
  collectSkillFiles,
  createStatelessSkillSnapshot,
  parseFrontmatter,
  SKILL_SNAPSHOT_MAX_BYTES,
  validateRelativePath,
} from "./skill-install";

const roots: string[] = [];

function skill(name = "demo-skill"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stateless-skill-test-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\n---\n# Demo\n`);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("stateless skill snapshots", () => {
  it("parses the declared name and rejects traversal names", () => {
    expect(parseFrontmatter("---\nname: demo-skill\n---\n")).toEqual({ name: "demo-skill" });
    expect(() => parseFrontmatter("---\nname: ../escape\n---\n")).toThrow("invalid");
  });

  it.each(["nested/file.txt", "a_b-c.1"])("accepts safe relative path %s", (candidate) => {
    expect(validateRelativePath(candidate)).toBe(true);
  });

  it.each(["../escape", "a/../b", "space name", "a//b", ""])(
    "rejects unsafe relative path %j",
    (candidate) => {
      expect(validateRelativePath(candidate)).toBe(false);
    },
  );

  it("rejects symlinks and special files instead of following them", () => {
    const root = skill();
    fs.symlinkSync(path.join(root, "SKILL.md"), path.join(root, "link"));

    expect(collectSkillFiles(root).unsupportedPaths).toEqual(["link"]);
    const stat = fs.lstatSync(root);
    expect(createStatelessSkillSnapshot(root, "demo-skill", stat)).toEqual({
      success: false,
      reason: "invalid-tree",
      paths: ["link"],
    });
  });

  it("creates a private regular-file snapshot and removes it on cleanup", () => {
    const root = skill();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, ".secret"), "not transferred");
    const stat = fs.lstatSync(root);
    const result = createStatelessSkillSnapshot(root, "demo-skill", stat);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.snapshot.files).toEqual(["SKILL.md", "nested/tool.sh"]);
    expect(result.snapshot.skippedDotfiles).toEqual([".secret"]);
    expect(fs.statSync(result.snapshot.hostDirectory).mode & 0o777).toBe(0o700);
    expect(
      fs.lstatSync(path.join(result.snapshot.skillDirectory, "nested", "tool.sh")).isFile(),
    ).toBe(true);
    result.snapshot.cleanup();
    expect(fs.existsSync(result.snapshot.hostDirectory)).toBe(false);
  });

  it("rejects a source that exceeds the byte bound before copying it", () => {
    const root = skill();
    fs.writeFileSync(path.join(root, "large.bin"), "");
    fs.truncateSync(path.join(root, "large.bin"), SKILL_SNAPSHOT_MAX_BYTES + 1);

    expect(createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root))).toEqual({
      success: false,
      reason: "limit-exceeded",
    });
  });

  it("rejects a regular file replaced after enumeration", () => {
    const root = skill();
    const skillFile = path.join(root, "SKILL.md");
    const originalRealpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementationOnce(((target: fs.PathLike) => {
      const resolved = originalRealpath(target);
      fs.renameSync(skillFile, path.join(root, "original.SKILL.md"));
      fs.writeFileSync(skillFile, "---\nname: demo-skill\n---\n# Replaced\n");
      return resolved;
    }) as typeof fs.realpathSync);

    expect(createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root))).toEqual({
      success: false,
      reason: "source-changed",
    });
  });
});

describe("canonical writable-root fallbacks", () => {
  it("places only the named staged tree in the declared root", () => {
    const command = buildCanonicalSkillAddCommand(
      "/sandbox/.hermes/skills",
      "demo-skill",
      "/sandbox/.nemoclaw-skill-stage.0123456789abcdef0123456789abcdef/demo-skill",
    );
    const script = command[2] ?? "";

    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(script).toContain("/sandbox/.hermes/skills");
    expect(script).toContain('destination="$name"');
    expect(script).toContain("Refusing to replace existing %s");
    expect(script).toContain('mv -T -- "$temporary" "$destination"');
    expect(script).not.toContain('rm -rf -- "$destination"');
    expect(script).toContain("Native skill list and new sessions remain authoritative");
    expect(script).not.toContain("receipt");
    expect(script).not.toContain("provenance");
    expect(script).not.toContain("/sandbox/.openclaw");
  });

  it("removes only the named canonical-root copy and makes no global-absence claim", () => {
    const command = buildCanonicalSkillRemoveCommand(
      "/sandbox/.openclaw/workspace/skills",
      "demo-skill",
    );
    const script = command[2] ?? "";

    expect(script).toContain('cd -P -- "$root"');
    expect(script).toContain('destination="$name"');
    expect(script).toContain('expected_destination="$root/$name"');
    expect(script).toContain('"$(realpath -e -- "$destination")" = "$expected_destination"');
    expect(script).toContain("only from the canonical writable skill root");
    expect(script).toContain("Native skill list remains authoritative");
    expect(script).not.toContain("/sandbox/.openclaw/skills");
    expect(script).not.toContain("find /sandbox");
  });

  it.each(["/tmp/skills", "/sandbox/a/../skills", "/sandbox/a b"])(
    "rejects unsafe declared root %j",
    (root) => {
      expect(() => buildCanonicalSkillRemoveCommand(root, "demo-skill")).toThrow(
        "Invalid canonical writable skill root",
      );
    },
  );
});
