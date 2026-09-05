// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import {
  bindNativeSkillCommandToSandboxIdentity,
  collectFiles,
  parseFrontmatter,
  resolveNativeSkillState,
  validateRelativePath,
} from "./skill-install";

describe("parseFrontmatter", () => {
  it("extracts name from valid frontmatter", () => {
    const result = parseFrontmatter("---\nname: my-skill\ndescription: test\n---\n# Body");
    expect(result).toEqual({ name: "my-skill" });
  });

  it("handles quoted name values", () => {
    expect(parseFrontmatter('---\nname: "my-tool"\n---\n').name).toBe("my-tool");
    expect(parseFrontmatter("---\nname: 'demo.tool'\n---\n").name).toBe("demo.tool");
  });

  it("handles name with dots, hyphens, and underscores", () => {
    expect(parseFrontmatter("---\nname: my_skill.v2-beta\n---\n").name).toBe("my_skill.v2-beta");
  });

  it("parses complex YAML metadata beyond name", () => {
    const fm = parseFrontmatter(
      '---\nname: rich-skill\ndescription: "A skill"\nmetadata: { "openclaw": { "emoji": "🔧" } }\n---\n',
    );
    expect(fm.name).toBe("rich-skill");
  });

  it("rejects malformed YAML", () => {
    expect(() => parseFrontmatter("---\nname: ok\ndescription: [broken\n---\n")).toThrow(
      "not valid YAML",
    );
  });

  it("rejects non-mapping frontmatter", () => {
    expect(() => parseFrontmatter("---\n- just\n- a list\n---\n")).toThrow(
      "must be a YAML mapping",
    );
  });

  it("throws when frontmatter is missing entirely", () => {
    expect(() => parseFrontmatter("# Just markdown\nNo frontmatter")).toThrow(
      "missing YAML frontmatter",
    );
  });

  it("throws when closing delimiter is missing", () => {
    expect(() => parseFrontmatter("---\nname: broken\n# No closing")).toThrow(
      "missing closing --- frontmatter delimiter",
    );
  });

  it("throws when name field is absent", () => {
    expect(() => parseFrontmatter("---\ndescription: no name here\n---\n")).toThrow(
      "missing required 'name' field",
    );
  });

  it("throws when name field is empty or null", () => {
    expect(() => parseFrontmatter("---\nname:\n---\n")).toThrow("missing required 'name' field");
    expect(() => parseFrontmatter('---\nname: ""\n---\n')).toThrow("missing required 'name' field");
  });

  it("rejects names with invalid characters", () => {
    expect(() => parseFrontmatter("---\nname: my skill\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: ../escape\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: a/b\n---\n")).toThrow("is invalid");
  });

  it("rejects dot and double-dot as skill names in frontmatter", () => {
    expect(() => parseFrontmatter("---\nname: .\n---\n")).toThrow("is invalid");
    expect(() => parseFrontmatter("---\nname: ..\n---\n")).toThrow("is invalid");
  });
});

describe("validateRelativePath", () => {
  it("accepts safe paths", () => {
    expect(validateRelativePath("SKILL.md")).toBe(true);
    expect(validateRelativePath("scripts/helper.js")).toBe(true);
    expect(validateRelativePath("data/config-v2.yaml")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(validateRelativePath("$(touch /tmp/pwn).js")).toBe(false);
    expect(validateRelativePath("a'b.txt")).toBe(false);
    expect(validateRelativePath('a"b.txt')).toBe(false);
    expect(validateRelativePath("a`b`.txt")).toBe(false);
    expect(validateRelativePath("file name.txt")).toBe(false);
    expect(validateRelativePath("a;rm -rf.txt")).toBe(false);
  });

  it("rejects directory traversal", () => {
    expect(validateRelativePath("../escape")).toBe(false);
    expect(validateRelativePath("foo/../../etc/passwd")).toBe(false);
    expect(validateRelativePath("./current")).toBe(false);
  });

  it("rejects empty and degenerate paths", () => {
    expect(validateRelativePath("")).toBe(false);
    expect(validateRelativePath("/absolute")).toBe(false);
    expect(validateRelativePath("foo//bar")).toBe(false);
  });
});

describe("collectFiles", () => {
  let tmpDir: string;

  function setup(files: Record<string, string>) {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-test-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(tmpDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  function cleanup() {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("collects a single SKILL.md", () => {
    setup({ "SKILL.md": "---\nname: solo\n---\n" });
    try {
      const { files, skippedDotfiles, unsafePaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(skippedDotfiles).toEqual([]);
      expect(unsafePaths).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("collects SKILL.md plus nested scripts, skips dotfiles", () => {
    setup({
      "SKILL.md": "---\nname: rich\n---\n",
      "scripts/helper.js": "console.log('hi')",
      ".env": "KEY=val",
    });
    try {
      const { files, skippedDotfiles } = collectFiles(tmpDir);
      expect(files.sort()).toEqual(["SKILL.md", "scripts/helper.js"]);
      expect(skippedDotfiles).toEqual([".env"]);
    } finally {
      cleanup();
    }
  });

  it("reports hidden directories in skippedDotfiles", () => {
    setup({
      "SKILL.md": "---\nname: safe\n---\n",
      ".secret/token.txt": "secret-value",
      "scripts/visible.sh": "#!/bin/sh",
      "scripts/.hidden.sh": "#!/bin/sh",
    });
    try {
      const { files, skippedDotfiles } = collectFiles(tmpDir);
      expect(files.sort()).toEqual(["SKILL.md", "scripts/visible.sh"]);
      expect(skippedDotfiles.sort()).toEqual([".secret/", "scripts/.hidden.sh"]);
    } finally {
      cleanup();
    }
  });

  it("flags files with unsafe characters", () => {
    setup({
      "SKILL.md": "---\nname: bad\n---\n",
      "has space.txt": "content",
    });
    try {
      const { files, unsafePaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(unsafePaths).toEqual(["has space.txt"]);
    } finally {
      cleanup();
    }
  });

  it("rejects visible symlinks instead of following their targets", () => {
    setup({ "SKILL.md": "---\nname: linked\n---\n" });
    try {
      symlinkSync("SKILL.md", join(tmpDir, "alias.md"));
      const { files, unsupportedPaths } = collectFiles(tmpDir);
      expect(files).toEqual(["SKILL.md"]);
      expect(unsupportedPaths).toEqual(["alias.md"]);
    } finally {
      cleanup();
    }
  });
});

describe("resolveNativeSkillState", () => {
  it("returns only the OpenClaw state boundary", () => {
    expect(resolveNativeSkillState(null)).toEqual({
      stateDir: "/sandbox/.openclaw",
      isOpenClaw: true,
    });
  });

  it.each([
    ["hermes", "/sandbox/.hermes"],
    ["langchain-deepagents-code", "/sandbox/.deepagents"],
  ])("returns only %s agent state without computing a skill destination", (name, stateDir) => {
    expect(resolveNativeSkillState({ name, configPaths: { dir: stateDir } })).toEqual({
      stateDir,
      isOpenClaw: false,
    });
  });
});

describe("bindNativeSkillCommandToSandboxIdentity", () => {
  it("checks the durable in-sandbox identity before the fixed native command", () => {
    const expected = "f".repeat(64);
    const command = bindNativeSkillCommandToSandboxIdentity(
      ["/usr/local/bin/openclaw", "skills", "remove", "demo-skill"],
      expected,
    );

    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command[2]).toContain(expected);
    expect(command[2]).toContain("OPENSHELL_SANDBOX_ID");
    expect(command[2]).toContain("exec '/usr/local/bin/openclaw' 'skills' 'remove' 'demo-skill'");
  });
});
