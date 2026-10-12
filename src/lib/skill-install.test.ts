// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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

function runCanonicalSkillAddWithMoveShim(moveShim: string): {
  destination: string;
  result: SpawnSyncReturns<string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-publication-test-"));
  roots.push(root);
  const sandboxRoot = path.join(root, "sandbox");
  const source = path.join(sandboxRoot, ".nemoclaw-skill-stage.receipt", "demo-skill");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  const snapshot = createStatelessSkillSnapshot(source, "demo-skill", fs.lstatSync(source));
  expect(snapshot.success).toBe(true);
  assert(snapshot.success);
  roots.push(snapshot.snapshot.hostDirectory);

  const command = buildCanonicalSkillAddCommand(
    "/sandbox/.deepagents/agent/skills",
    "demo-skill",
    "/sandbox/.nemoclaw-skill-stage.receipt/demo-skill",
    snapshot.snapshot.contentDigest,
  );
  expect(root).not.toMatch(/['\n\r]/u);
  const script = (command[2] ?? "").replaceAll("/sandbox", sandboxRoot);
  const shimDirectory = path.join(root, "bin");
  fs.mkdirSync(shimDirectory);
  fs.writeFileSync(path.join(shimDirectory, "mv"), `#!/bin/sh\n${moveShim}\n`, { mode: 0o755 });
  const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
  expect(realMv).not.toBe("");
  const result = spawnSync(command[0], [command[1], script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_REAL_MV: realMv,
      PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
    },
  });

  return {
    destination: path.join(sandboxRoot, ".deepagents/agent/skills/demo-skill"),
    result,
  };
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
    expect(result.snapshot.contentDigest).toBe(
      "4e4e4b41e297b6aa262e0adab773584f52809fbf688d9a44ea5a863ebcfe0b8c",
    );
    expect(result.snapshot.skippedDotfiles).toEqual([".secret"]);
    expect(fs.statSync(result.snapshot.hostDirectory).mode & 0o777).toBe(0o700);
    expect(
      fs.lstatSync(path.join(result.snapshot.skillDirectory, "nested", "tool.sh")).isFile(),
    ).toBe(true);
    result.snapshot.cleanup();
    expect(fs.existsSync(result.snapshot.hostDirectory)).toBe(false);
  });

  it("changes the snapshot digest when content or executable mode changes (#8470)", () => {
    const root = skill();
    const script = path.join(root, "tool.sh");
    fs.writeFileSync(script, "#!/bin/sh\nprintf first\\n", { mode: 0o644 });

    const first = createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root));
    expect(first.success).toBe(true);
    const firstSnapshot = (first as Extract<typeof first, { success: true }>).snapshot;
    const firstDigest = firstSnapshot.contentDigest;
    firstSnapshot.cleanup();

    fs.chmodSync(script, 0o755);
    const executable = createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root));
    expect(executable.success).toBe(true);
    const executableSnapshot = (executable as Extract<typeof executable, { success: true }>)
      .snapshot;
    expect(executableSnapshot.contentDigest).not.toBe(firstDigest);
    executableSnapshot.cleanup();

    fs.writeFileSync(script, "#!/bin/sh\nprintf second\\n", { mode: 0o755 });
    const changed = createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root));
    expect(changed.success).toBe(true);
    const changedSnapshot = (changed as Extract<typeof changed, { success: true }>).snapshot;
    expect(changedSnapshot.contentDigest).not.toBe(executableSnapshot.contentDigest);
    changedSnapshot.cleanup();
  });

  it("normalizes snapshot modes when the process umask removes execute bits (#8470)", () => {
    const root = skill();
    const script = path.join(root, "nested", "tool.sh");
    fs.mkdirSync(path.dirname(script));
    fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
    const previousUmask = process.umask(0o111);
    const result = (() => {
      try {
        return createStatelessSkillSnapshot(root, "demo-skill", fs.lstatSync(root));
      } finally {
        process.umask(previousUmask);
      }
    })();

    expect(result.success).toBe(true);
    assert(result.success);
    roots.push(result.snapshot.hostDirectory);
    expect(fs.statSync(result.snapshot.skillDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(result.snapshot.skillDirectory, "nested")).mode & 0o777).toBe(
      0o755,
    );
    expect(
      fs.statSync(path.join(result.snapshot.skillDirectory, "nested", "tool.sh")).mode & 0o777,
    ).toBe(0o755);
    result.snapshot.cleanup();
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
  it("verifies Deep Agents content before and after atomic publication (#8470)", () => {
    const digest = "a".repeat(64);
    const command = buildCanonicalSkillAddCommand(
      "/sandbox/.deepagents/agent/skills",
      "demo-skill",
      "/sandbox/.nemoclaw-skill-stage.0123456789abcdef0123456789abcdef/demo-skill",
      digest,
    );
    const script = command[2] ?? "";

    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(script).toContain('LC_ALL=C sort "$verification/unsorted-files"');
    expect(script).toContain("mode=755");
    expect(script).toContain('sha256sum -- "$candidate"');
    expect(script).toContain('verify_tree "$temporary"');
    expect(script.indexOf('verify_tree "$temporary"')).toBeLessThan(
      script.indexOf('mv -T -- "$temporary" "$destination"'),
    );
    expect(script.indexOf('verify_tree "$destination"')).toBeGreaterThan(
      script.indexOf('mv -T -- "$temporary" "$destination"'),
    );
    expect(script).toContain('published="$destination"');
    expect(script.indexOf('published="$destination"')).toBeLessThan(
      script.indexOf('mv -T -- "$temporary" "$destination"'),
    );
    expect(script).toContain('publication_identity="$(stat -c "%d:%i" -- "$temporary")"');
    expect(script).toContain('observed_publication_identity="$(stat -c "%d:%i" -- "$published"');
    expect(script).not.toContain("Content digest (SHA-256)");
    expect(script).toContain(digest);
  });

  it.runIf(process.platform === "linux")(
    "publishes a verified snapshot with matching content (#8470)",
    () => {
      const { destination, result } = runCanonicalSkillAddWithMoveShim(
        'exec "$NEMOCLAW_REAL_MV" "$@"',
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe(
        "---\nname: demo-skill\n---\n# Demo\n",
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "rolls back publication when the tree changes during the move (#8470)",
    () => {
      const { destination, result } = runCanonicalSkillAddWithMoveShim(
        'printf "changed during publication\\n" >> "$3/SKILL.md"\nexec "$NEMOCLAW_REAL_MV" "$@"',
      );

      expect(result.status, result.stderr).not.toBe(0);
      expect(fs.existsSync(destination)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "removes its published tree when cancellation follows the move (#8470)",
    () => {
      const { destination, result } = runCanonicalSkillAddWithMoveShim(
        '"$NEMOCLAW_REAL_MV" "$@"\nkill -TERM "$PPID"',
      );

      expect(result.status, result.stderr).not.toBe(0);
      expect(fs.existsSync(destination)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves a competing destination when publication loses the race (#8470)",
    () => {
      const { destination, result } = runCanonicalSkillAddWithMoveShim(
        'mkdir -p -- "$4"\nprintf "competing transaction\\n" > "$4/SKILL.md"\nexit 1',
      );

      expect(result.status, result.stderr).not.toBe(0);
      expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe(
        "competing transaction\n",
      );
    },
  );

  it.each(["invalid", "A".repeat(64), "a".repeat(63)])(
    "rejects invalid skill content digest %j",
    (digest) => {
      expect(() =>
        buildCanonicalSkillAddCommand(
          "/sandbox/.deepagents/agent/skills",
          "demo-skill",
          "/sandbox/.nemoclaw-skill-stage.0123456789abcdef0123456789abcdef/demo-skill",
          digest,
        ),
      ).toThrow("Invalid skill content digest");
    },
  );

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
    expect(script).not.toContain("safe_rel");
    expect(script).not.toContain(".nemoclaw-skill-verify");
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
