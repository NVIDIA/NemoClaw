// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectProtectedDcodeBase,
  verifyProtectedDcodeBaseReceipt,
  type ProtectedDcodeBaseIdentity,
} from "../../../scripts/checks/protected-dcode-base-receipt.mts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(
  platform: ProtectedDcodeBaseIdentity["platform"] = "linux/amd64",
  agent: "openclaw" | "hermes" | "langchain-deepagents-code" = "langchain-deepagents-code",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-dcode-base-"));
  directories.push(root);
  const layout = path.join(root, "base");
  fs.mkdirSync(path.join(layout, "blobs/sha256"), { recursive: true });
  const expected: ProtectedDcodeBaseIdentity = {
    sourceRevision: "a".repeat(40),
    workflowSha: "b".repeat(40),
    cohort: "protected-37164014229-1",
    platform,
  };
  function blob(body: Buffer, mediaType: string) {
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    fs.writeFileSync(path.join(layout, "blobs/sha256", digest.slice(7)), body);
    return { digest, size: body.length, mediaType };
  }
  function jsonBlob(value: unknown, mediaType: string) {
    return blob(Buffer.from(JSON.stringify(value)), mediaType);
  }
  const config = jsonBlob(
    {
      os: "linux",
      architecture: platform.slice(6),
      config: {
        Labels: {
          "org.opencontainers.image.revision": expected.sourceRevision,
          "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
          "io.nvidia.nemoclaw.managed-image.cohort": expected.cohort,
          "io.nvidia.nemoclaw.agent": agent,
        },
      },
    },
    "application/vnd.oci.image.config.v1+json",
  );
  const layer = blob(
    Buffer.alloc(2 * 1024 * 1024 + 7, 42),
    "application/vnd.oci.image.layer.v1.tar",
  );
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config,
    layers: [layer],
  };
  function setManifest(value: unknown) {
    const descriptor = jsonBlob(value, "application/vnd.oci.image.manifest.v1+json");
    fs.writeFileSync(
      path.join(layout, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
    );
    return descriptor;
  }
  const descriptor = setManifest(manifest);
  fs.writeFileSync(
    path.join(layout, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
  const receiptPath = path.join(root, "receipt.json");
  const receipt = inspectProtectedDcodeBase(layout, expected, agent);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return {
    layout,
    root,
    expected,
    receiptPath,
    receipt,
    layer,
    config,
    manifest,
    descriptor,
    setManifest,
  };
}

describe("protected DCode base artifact handoff", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "binds %s to its OCI artifact",
    (agent) => {
      const f = fixture("linux/amd64", agent);
      expect(verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected, agent)).toEqual(
        f.receipt,
      );
    },
  );

  it.each([
    ["openclaw", "hermes"],
    ["openclaw", "langchain-deepagents-code"],
    ["hermes", "openclaw"],
    ["hermes", "langchain-deepagents-code"],
    ["langchain-deepagents-code", "openclaw"],
    ["langchain-deepagents-code", "hermes"],
  ] as const)("rejects %s OCI bytes when %s is required", (agent, other) => {
    const f = fixture("linux/amd64", agent);
    expect(() =>
      verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected, other),
    ).toThrow(/config/);
  });

  it("rejects an unsupported agent before reading the layout", () => {
    const f = fixture();
    expect(() =>
      inspectProtectedDcodeBase("/missing", f.expected, "../other" as "openclaw"),
    ).toThrow(/not supported/);
  });

  it("writes receipts once and refuses to overwrite existing evidence", () => {
    const f = fixture();
    const receiptPath = path.join(f.root, "cli-receipt.json");
    const args = [
      fileURLToPath(
        new URL("../../../scripts/checks/protected-dcode-base-receipt.mts", import.meta.url),
      ),
      "write",
      f.layout,
      receiptPath,
    ];
    const options = {
      encoding: "utf8" as const,
      env: {
        ...process.env,
        CHECKOUT_SHA: f.expected.sourceRevision,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: f.expected.workflowSha,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT: f.expected.cohort,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM: f.expected.platform,
      },
    };
    const first = spawnSync(process.execPath, args, options);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe(f.receipt.reference);
    const receiptFd = fs.openSync(receiptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(receiptFd);
      expect(opened.mode & 0o777).toBe(0o600);
      const bytes = fs.readFileSync(receiptFd);
      const second = spawnSync(process.execPath, args, options);
      expect(second.status, second.stderr).toBe(1);
      expect(second.stderr).toContain("EEXIST");
      const afterStat = fs.fstatSync(receiptFd);
      expect(afterStat.size).toBe(bytes.length);
      const after = Buffer.alloc(bytes.length);
      expect(fs.readSync(receiptFd, after, 0, after.length, 0)).toBe(bytes.length);
      expect(after).toEqual(bytes);
      const pathStat = fs.lstatSync(receiptPath);
      expect([pathStat.dev, pathStat.ino]).toEqual([opened.dev, opened.ino]);
    } finally {
      fs.closeSync(receiptFd);
    }
  });

  it.each(["linux/amd64", "linux/arm64"] as const)(
    "binds the complete OCI image on %s",
    (platform) => {
      const f = fixture(platform);
      expect(verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected)).toEqual(
        f.receipt,
      );
      expect(f.receipt.digest).toBe(f.descriptor.digest);
      expect(f.receipt.imageId).toBe(f.config.digest);
      expect(f.receipt.reference).toBe(
        `localhost:5000/nemoclaw-managed-protected-base/langchain-deepagents-code@${f.descriptor.digest}`,
      );
    },
  );

  it.each([
    { sourceRevision: "c".repeat(40) },
    { workflowSha: "d".repeat(40) },
    { cohort: "protected-37164014229-2" },
    { cohort: "protected-37164014230-1" },
    { platform: "linux/arm64" as const },
  ])("rejects reuse across a different dispatch identity: %j", (change) => {
    const f = fixture();
    expect(() =>
      verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, { ...f.expected, ...change }),
    ).toThrow();
  });

  it.each(["digest", "imageId", "reference", "unexpected"])(
    "rejects substituted receipt field %s",
    (field) => {
      const f = fixture();
      fs.writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, [field]: "substituted" }));
      expect(() => verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected)).toThrow(
        /receipt/,
      );
    },
  );

  it.each([
    {
      kind: "corrupt",
      mutate: (filename: string, _f: ReturnType<typeof fixture>) => {
        const fd = fs.openSync(filename, "r+");
        fs.writeSync(fd, Buffer.from([0]), 0, 1, 1024 * 1024 + 2);
        fs.closeSync(fd);
      },
    },
    {
      kind: "truncate",
      mutate: (filename: string, f: ReturnType<typeof fixture>) => {
        fs.truncateSync(filename, f.layer.size - 1);
      },
    },
    {
      kind: "missing",
      mutate: (filename: string, f: ReturnType<typeof fixture>) => {
        fs.renameSync(filename, path.join(f.root, "outside"));
      },
    },
    {
      kind: "symlink",
      mutate: (filename: string, f: ReturnType<typeof fixture>) => {
        fs.renameSync(filename, path.join(f.root, "outside"));
        fs.symlinkSync(path.join(f.root, "outside"), filename);
      },
    },
  ])("rejects a $kind layer before using its image", ({ mutate }) => {
    const f = fixture();
    const filename = path.join(f.layout, "blobs/sha256", f.layer.digest.slice(7));
    mutate(filename, f);
    expect(() => verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected)).toThrow();
  });

  it("rejects a remote layer even when its local bytes match", () => {
    const f = fixture();
    f.setManifest({
      ...f.manifest,
      layers: [{ ...f.layer, urls: ["https://example.invalid/layer"] }],
    });
    expect(() => inspectProtectedDcodeBase(f.layout, f.expected)).toThrow(/external content/);
  });

  it("does not accept a manifest swapped after its bytes are verified", () => {
    const f = fixture();
    const manifestPath = path.join(f.layout, "blobs/sha256", f.descriptor.digest.slice(7));
    const layerPath = path.join(f.layout, "blobs/sha256", f.layer.digest.slice(7));
    const manifestInode = fs.statSync(manifestPath).ino;
    const originalClose = fs.closeSync.bind(fs);
    let swapped = false;
    const close = vi.spyOn(fs, "closeSync");
    close.mockImplementationOnce(originalClose).mockImplementationOnce(originalClose);
    close.mockImplementationOnce((fd) => {
      expect(fs.fstatSync(fd).ino).toBe(manifestInode);
      originalClose(fd);
      fs.renameSync(manifestPath, path.join(f.root, "original-manifest"));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...f.manifest, layers: [] }));
      fs.truncateSync(layerPath, 1);
      swapped = true;
    });
    try {
      expect(() => inspectProtectedDcodeBase(f.layout, f.expected)).toThrow(/blob size/);
      expect(swapped).toBe(true);
    } finally {
      close.mockRestore();
    }
  });

  it("rejects symlinked receipt and blob directories", () => {
    const f = fixture();
    fs.renameSync(f.receiptPath, path.join(f.root, "real-receipt"));
    fs.symlinkSync(path.join(f.root, "real-receipt"), f.receiptPath);
    expect(() => verifyProtectedDcodeBaseReceipt(f.layout, f.receiptPath, f.expected)).toThrow();
    fs.renameSync(path.join(f.layout, "blobs"), path.join(f.root, "real-blobs"));
    fs.symlinkSync(path.join(f.root, "real-blobs"), path.join(f.layout, "blobs"));
    expect(() => inspectProtectedDcodeBase(f.layout, f.expected)).toThrow(/symlinks/);
  });

  it("rejects ambiguous multi-image indexes", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.layout, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [f.descriptor, f.descriptor] }),
    );
    expect(() => inspectProtectedDcodeBase(f.layout, f.expected)).toThrow(/one OCI image/);
  });
});
