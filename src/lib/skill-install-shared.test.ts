// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeSkillContentDigest,
  installFreshSharedSkill,
  resolveSkillPaths,
} from "./skill-install";
import type { SshResult } from "./skill-remote";

const CTX = { configFile: "/tmp/ssh-config", sandboxName: "alpha" };
const AGENT_NAME = "langchain-deepagents-code";

function makeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-skill-"));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: note-summarizer\n---\n# Notes\n");
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "summarize.js"), "export default 'exact';\n");
  chmodSync(join(dir, "scripts", "summarize.js"), 0o755);
  return dir;
}

function pathsFor(stateDir: string) {
  return resolveSkillPaths({ name: AGENT_NAME, configPaths: { dir: stateDir } }, "note-summarizer");
}

const COLLISION_CASES = [
  {
    kind: "file",
    prepare: (destination: string, _outside: string) => writeFileSync(destination, "agent file\n"),
    assertUnchanged: (destination: string) =>
      expect(readFileSync(destination, "utf8")).toBe("agent file\n"),
  },
  {
    kind: "directory",
    prepare: (destination: string, _outside: string) => {
      mkdirSync(destination);
      writeFileSync(join(destination, "agent.txt"), "agent directory\n");
    },
    assertUnchanged: (destination: string) =>
      expect(readFileSync(join(destination, "agent.txt"), "utf8")).toBe("agent directory\n"),
  },
  {
    kind: "symlink",
    prepare: (destination: string, outside: string) => symlinkSync(outside, destination),
    assertUnchanged: (destination: string) =>
      expect(readFileSync(destination, "utf8")).toBe("outside\n"),
  },
] as const;

function executeShell(
  command: string,
  input: string | Buffer | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SshResult {
  const run = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env,
    input,
  });
  return {
    status: run.status ?? 1,
    stdout: (run.stdout || "").trim(),
    stderr: (run.stderr || "").trim(),
  };
}

describe("fresh shared-agent skill install", () => {
  it("streams one host-attested archive to an atomic no-clobber activation", () => {
    const skillDir = makeSkill();
    const paths = pathsFor("/sandbox/.deepagents");
    const expected = computeSkillContentDigest(skillDir);
    try {
      const result = installFreshSharedSkill(CTX, skillDir, paths, {
        sshExecImpl: (_ctx, _command, opts) => {
          expect(Buffer.isBuffer(opts?.input)).toBe(true);
          return { status: 0, stdout: `INSTALLED ${expected}`, stderr: "" };
        },
      });

      expect(result).toEqual({
        success: true,
        uploaded: 2,
        contentDigest: expected,
      });
      expect(paths.uploadDir).toBe("/sandbox/.deepagents/agent/skills/note-summarizer");
      expect(paths.mirrorDir).toBeNull();
      expect(paths.uploadDirSharedWithAgent).toBe(true);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("includes normalized executable modes in the immutable content digest", () => {
    const skillDir = makeSkill();
    try {
      const executableDigest = computeSkillContentDigest(skillDir);
      chmodSync(join(skillDir, "scripts", "summarize.js"), 0o644);

      expect(computeSkillContentDigest(skillDir)).not.toBe(executableDigest);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot whose SKILL.md name does not match the resolved destination", () => {
    const skillDir = makeSkill();
    const paths = pathsFor("/sandbox/.deepagents");
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: different-skill\n---\n# Notes\n");
    let called = false;
    try {
      const result = installFreshSharedSkill(CTX, skillDir, paths, {
        sshExecImpl: () => {
          called = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(result).toEqual({
        success: false,
        uploaded: 0,
        reason: "snapshot_failed",
      });
      expect(called).toBe(false);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot that does not contain a regular SKILL.md", () => {
    const skillDir = makeSkill();
    const paths = pathsFor("/sandbox/.deepagents");
    rmSync(join(skillDir, "SKILL.md"));
    let called = false;
    try {
      const result = installFreshSharedSkill(CTX, skillDir, paths, {
        sshExecImpl: () => {
          called = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(result).toEqual({
        success: false,
        uploaded: 0,
        reason: "snapshot_failed",
      });
      expect(called).toBe(false);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("rejects a directory swapped to a symlink before snapshot reads (#7634)", () => {
    const skillDir = makeSkill();
    const outsideDir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-outside-"));
    const paths = pathsFor("/sandbox/.deepagents");
    writeFileSync(join(outsideDir, "summarize.js"), "external secret\n");
    let sshCalled = false;
    const beforeSnapshotFileRead = new Map<string, () => void>([
      [
        "scripts/summarize.js",
        () => {
          rmSync(join(skillDir, "scripts"), { recursive: true, force: true });
          symlinkSync(outsideDir, join(skillDir, "scripts"), "dir");
        },
      ],
    ]);
    try {
      const result = installFreshSharedSkill(CTX, skillDir, paths, {
        beforeSnapshotFileRead: (relativePath) => beforeSnapshotFileRead.get(relativePath)?.(),
        sshExecImpl: () => {
          sshCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(result).toEqual({
        success: false,
        uploaded: 0,
        reason: "snapshot_failed",
      });
      expect(sshCalled).toBe(false);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects the selected skill root when it is swapped before snapshot creation (#7634)", () => {
    const skillDir = makeSkill();
    const replacementDir = makeSkill();
    const originalRoot = lstatSync(skillDir);
    const paths = pathsFor("/sandbox/.deepagents");
    let sshCalled = false;
    try {
      const result = installFreshSharedSkill(CTX, skillDir, paths, {
        expectedRootIdentity: { dev: originalRoot.dev, ino: originalRoot.ino },
        beforeSnapshotRootRead: () => {
          rmSync(skillDir, { recursive: true, force: true });
          symlinkSync(replacementDir, skillDir, "dir");
        },
        sshExecImpl: () => {
          sshCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(result).toEqual({
        success: false,
        uploaded: 0,
        reason: "snapshot_failed",
      });
      expect(sshCalled).toBe(false);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
      rmSync(replacementDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "installs exact bytes directly and leaves the legacy upload path untouched",
    () => {
      const skillDir = makeSkill();
      const stateDir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-state-"));
      const paths = pathsFor(stateDir);
      const legacy = join(stateDir, "skills", "note-summarizer");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "legacy.txt"), "preserve me\n");
      try {
        const result = installFreshSharedSkill(CTX, skillDir, paths, {
          sshExecImpl: (_ctx, command, opts) => executeShell(command, opts?.input),
        });

        expect(result.success).toBe(true);
        expect(readFileSync(join(paths.uploadDir, "SKILL.md"), "utf8")).toContain("# Notes");
        expect(readFileSync(join(paths.uploadDir, "scripts", "summarize.js"), "utf8")).toBe(
          "export default 'exact';\n",
        );
        expect(lstatSync(join(paths.uploadDir, "SKILL.md")).mode & 0o777).toBe(0o644);
        expect(lstatSync(join(paths.uploadDir, "scripts", "summarize.js")).mode & 0o777).toBe(
          0o755,
        );
        expect(readFileSync(join(legacy, "legacy.txt"), "utf8")).toBe("preserve me\n");
      } finally {
        rmSync(skillDir, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux").each(COLLISION_CASES)(
    "refuses an existing $kind without changing it (#7634)",
    ({ kind, prepare, assertUnchanged }) => {
      const skillDir = makeSkill();
      const stateDir = mkdtempSync(join(tmpdir(), `nemoclaw-shared-${kind}-`));
      const paths = pathsFor(stateDir);
      mkdirSync(join(stateDir, "agent", "skills"), { recursive: true });
      const outside = join(stateDir, "outside");
      writeFileSync(outside, "outside\n");
      prepare(paths.uploadDir, outside);
      const before = lstatSync(paths.uploadDir);
      try {
        const result = installFreshSharedSkill(CTX, skillDir, paths, {
          sshExecImpl: (_ctx, command, opts) => executeShell(command, opts?.input),
        });

        expect(result).toEqual({
          success: false,
          uploaded: 0,
          reason: "destination_exists",
        });
        expect(lstatSync(paths.uploadDir).isSymbolicLink()).toBe(before.isSymbolicLink());
        assertUnchanged(paths.uploadDir);
      } finally {
        rmSync(skillDir, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "detects a no-clobber race when mv reports success but leaves staging",
    () => {
      const skillDir = makeSkill();
      const stateDir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-race-"));
      const fakeBin = mkdtempSync(join(tmpdir(), "nemoclaw-fake-mv-"));
      const paths = pathsFor(stateDir);
      const fakeMv = join(fakeBin, "mv");
      writeFileSync(fakeMv, '#!/bin/sh\nmkdir -- "$RACE_DEST"\nexec /usr/bin/mv "$@"\n');
      chmodSync(fakeMv, 0o755);
      try {
        const result = installFreshSharedSkill(CTX, skillDir, paths, {
          sshExecImpl: (_ctx, command, opts) =>
            executeShell(command, opts?.input, {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH}`,
              RACE_DEST: "note-summarizer",
            }),
        });

        expect(result.reason).toBe("destination_exists");
        expect(existsSync(paths.uploadDir)).toBe(true);
        expect(readdirSync(paths.uploadDir)).toEqual([]);
        expect(
          readdirSync(join(stateDir, "agent", "skills")).some((name) =>
            name.startsWith(".nemoclaw-skill."),
          ),
        ).toBe(false);
      } finally {
        rmSync(skillDir, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(fakeBin, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed on a corrupt archive and leaves no active destination",
    () => {
      const skillDir = makeSkill();
      const stateDir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-corrupt-"));
      const paths = pathsFor(stateDir);
      try {
        const result = installFreshSharedSkill(CTX, skillDir, paths, {
          sshExecImpl: (_ctx, command) => executeShell(command, Buffer.from("not a tar archive")),
        });

        expect(result.reason).toBe("remote_state_unknown");
        expect(existsSync(paths.uploadDir)).toBe(false);
        expect(
          readdirSync(join(stateDir, "agent", "skills")).some((name) =>
            name.startsWith(".nemoclaw-skill."),
          ),
        ).toBe(false);
      } finally {
        rmSync(skillDir, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "classifies a non-collision move failure as unknown remote state",
    () => {
      const skillDir = makeSkill();
      const stateDir = mkdtempSync(join(tmpdir(), "nemoclaw-shared-move-failure-"));
      const fakeBin = mkdtempSync(join(tmpdir(), "nemoclaw-failing-mv-"));
      const paths = pathsFor(stateDir);
      const fakeMv = join(fakeBin, "mv");
      writeFileSync(fakeMv, "#!/bin/sh\nexit 1\n");
      chmodSync(fakeMv, 0o755);
      try {
        const result = installFreshSharedSkill(CTX, skillDir, paths, {
          sshExecImpl: (_ctx, command, opts) =>
            executeShell(command, opts?.input, {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH}`,
            }),
        });

        expect(result).toEqual({
          success: false,
          uploaded: 0,
          reason: "remote_state_unknown",
        });
        expect(existsSync(paths.uploadDir)).toBe(false);
      } finally {
        rmSync(skillDir, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(fakeBin, { recursive: true, force: true });
      }
    },
  );
});
