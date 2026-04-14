// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  parseFrontmatter,
  resolveSkillPaths,
  collectFiles,
  validateRelativePath,
  shellQuote,
} from "../../dist/lib/skill-install";

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
    expect(() =>
      parseFrontmatter("---\nname: ok\ndescription: [broken\n---\n"),
    ).toThrow("not valid YAML");
  });

  it("rejects non-mapping frontmatter", () => {
    expect(() => parseFrontmatter("---\n- just\n- a list\n---\n")).toThrow("must be a YAML mapping");
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
    expect(() => parseFrontmatter("---\nname: my skill\n---\n")).toThrow("invalid characters");
    expect(() => parseFrontmatter("---\nname: ../escape\n---\n")).toThrow("invalid characters");
    expect(() => parseFrontmatter("---\nname: a/b\n---\n")).toThrow("invalid characters");
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

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
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
});

describe("resolveSkillPaths", () => {
  it("returns OpenClaw defaults when agent is null", () => {
    const paths = resolveSkillPaths(null, "weather");
    expect(paths.uploadDir).toBe("/sandbox/.openclaw/skills/weather");
    expect(paths.mirrorDir).toBe("$HOME/.openclaw/skills/weather");
    expect(paths.sessionFile).toBe(
      "/sandbox/.openclaw-data/agents/main/sessions/sessions.json",
    );
    expect(paths.isOpenClaw).toBe(true);
  });

  it("returns OpenClaw paths when agent.name is 'openclaw'", () => {
    const agent = {
      name: "openclaw",
      configPaths: {
        immutableDir: "/sandbox/.openclaw",
        writableDir: "/sandbox/.openclaw-data",
      },
    };
    const paths = resolveSkillPaths(agent, "my-skill");
    expect(paths.uploadDir).toBe("/sandbox/.openclaw/skills/my-skill");
    expect(paths.mirrorDir).toBe("$HOME/.openclaw/skills/my-skill");
    expect(paths.sessionFile).toBe(
      "/sandbox/.openclaw-data/agents/main/sessions/sessions.json",
    );
    expect(paths.isOpenClaw).toBe(true);
  });

  it("returns Hermes paths without mirror or session refresh", () => {
    const agent = {
      name: "hermes",
      configPaths: {
        immutableDir: "/sandbox/.hermes",
        writableDir: "/sandbox/.hermes-data",
      },
    };
    const paths = resolveSkillPaths(agent, "demo-skill");
    expect(paths.uploadDir).toBe("/sandbox/.hermes/skills/demo-skill");
    expect(paths.mirrorDir).toBeNull();
    expect(paths.sessionFile).toBeNull();
    expect(paths.isOpenClaw).toBe(false);
  });

  it("returns generic paths for a hypothetical future agent", () => {
    const agent = {
      name: "future-agent",
      configPaths: {
        immutableDir: "/sandbox/.future",
        writableDir: "/sandbox/.future-data",
      },
    };
    const paths = resolveSkillPaths(agent, "test-skill");
    expect(paths.uploadDir).toBe("/sandbox/.future/skills/test-skill");
    expect(paths.mirrorDir).toBeNull();
    expect(paths.sessionFile).toBeNull();
    expect(paths.isOpenClaw).toBe(false);
  });
});
