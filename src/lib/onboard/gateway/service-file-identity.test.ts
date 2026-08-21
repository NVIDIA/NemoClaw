// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inspectServiceFileIdentity,
  type ServiceFileStat,
  sameServiceFileIdentity,
} from "./service-file-identity";

const CURRENT_UID = process.getuid?.() ?? 0;

function fileStat(
  stat: fs.BigIntStats,
  overrides: Partial<Pick<ServiceFileStat, "isFile" | "isSymbolicLink" | "uid">> = {},
): ServiceFileStat {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    isFile: overrides.isFile ?? (() => stat.isFile()),
    isSymbolicLink: overrides.isSymbolicLink ?? (() => stat.isSymbolicLink()),
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    nlink: stat.nlink,
    size: stat.size,
    uid: overrides.uid ?? stat.uid,
  };
}

describe("service file identity", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-service-identity-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { force: true, recursive: true });
  });

  it("returns descriptor metadata and a digest without the path or file bytes (#9705)", () => {
    const filePath = path.join(directory, "nemoclaw-openshell-gateway.service");
    const contents = Buffer.from("reviewed service definition\n");
    fs.writeFileSync(filePath, contents, { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);
    const stat = fs.lstatSync(filePath, { bigint: true });

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      hashContents: true,
    });

    expect(inspection).toEqual({
      identity: {
        changedTimeNanoseconds: String(stat.ctimeNs),
        contentSha256: createHash("sha256").update(contents).digest("hex"),
        device: String(stat.dev),
        inode: String(stat.ino),
        linkCount: String(stat.nlink),
        mode: 0o644,
        modifiedTimeNanoseconds: String(stat.mtimeNs),
        owner: CURRENT_UID,
        size: String(contents.length),
      },
    });
    expect(JSON.stringify(inspection)).not.toContain(filePath);
    expect(JSON.stringify(inspection)).not.toContain(contents.toString("utf8"));
  });

  it("returns file bytes only when a caller supplies a sufficient content limit (#9705)", () => {
    const filePath = path.join(directory, "nemoclaw-openshell-gateway.service");
    const contents = Buffer.from("reviewed service definition\n");
    fs.writeFileSync(filePath, contents);

    const bounded = inspectServiceFileIdentity({
      contentsLimit: contents.length,
      expectedUid: CURRENT_UID,
      filePath,
    });
    const tooSmall = inspectServiceFileIdentity({
      contentsLimit: contents.length - 1,
      expectedUid: CURRENT_UID,
      filePath,
    });

    expect(bounded?.contents).toEqual(contents);
    expect(bounded?.identity.contentSha256).toBe(
      createHash("sha256").update(contents).digest("hex"),
    );
    expect(tooSmall).toBeNull();
  });

  it("hashes a large executable in fixed-size descriptor reads (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    const contents = Buffer.alloc(64 * 1024 * 3 + 17, 0x5a);
    fs.writeFileSync(filePath, contents, { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
    const readLengths: number[] = [];

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      hashContents: true,
      readSync: (fileDescriptor, buffer, offset, length, position) => {
        readLengths.push(length);
        return fs.readSync(fileDescriptor, buffer, offset, length, position);
      },
      requiredModeBits: 0o100,
    });

    expect(inspection?.contents).toBeUndefined();
    expect(inspection?.identity.contentSha256).toBe(
      createHash("sha256").update(contents).digest("hex"),
    );
    expect(readLengths.length).toBeGreaterThan(1);
    expect(Math.max(...readLengths)).toBe(64 * 1024);
  });

  it("changes lifecycle identity after same-inode file content changes (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "first executable\n", { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
    const inodeBefore = fs.lstatSync(filePath, { bigint: true }).ino;
    const first = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      hashContents: true,
    });

    fs.writeFileSync(filePath, "other executable\n", { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
    const inodeAfter = fs.lstatSync(filePath, { bigint: true }).ino;
    const second = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      hashContents: true,
    });

    expect(inodeAfter).toBe(inodeBefore);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sameServiceFileIdentity(first!.identity, second!.identity)).toBe(false);
    expect(first?.identity.contentSha256).not.toBe(second?.identity.contentSha256);
  });

  it("rejects a path that is replaced after its descriptor is inspected (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    const openedPath = path.join(directory, "opened-openshell-gateway");
    const replacementPath = path.join(directory, "replacement-openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n", { mode: 0o755 });
    fs.writeFileSync(replacementPath, "hostile executable\n", { mode: 0o755 });
    let fstatCalls = 0;
    const afterFstat = [
      () => undefined,
      () => {
        fs.renameSync(filePath, openedPath);
        fs.renameSync(replacementPath, filePath);
      },
    ];

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      fstatSync: (fileDescriptor) => {
        const stat = fs.fstatSync(fileDescriptor, { bigint: true });
        afterFstat[fstatCalls]?.();
        fstatCalls += 1;
        return stat;
      },
      hashContents: true,
    });

    expect(inspection).toBeNull();
    expect(fs.readFileSync(openedPath, "utf8")).toBe("reviewed executable\n");
    expect(fs.readFileSync(filePath, "utf8")).toBe("hostile executable\n");
  });

  it("opens a regular file read-only without following links or blocking (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n");
    let observedFlags: number | undefined;

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      openSync: (candidate, flags) => {
        observedFlags = flags;
        return fs.openSync(candidate, flags);
      },
    });

    expect(inspection).not.toBeNull();
    expect(observedFlags).toBe(
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  });

  it("rejects a symbolic link without reading its target (#9705)", () => {
    const targetPath = path.join(directory, "target");
    const linkPath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(targetPath, "hostile executable\n");
    fs.symlinkSync(targetPath, linkPath);

    expect(
      inspectServiceFileIdentity({
        expectedUid: CURRENT_UID,
        filePath: linkPath,
        hashContents: true,
      }),
    ).toBeNull();
    expect(fs.readFileSync(targetPath, "utf8")).toBe("hostile executable\n");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer (#9705)",
    () => {
      const fifoPath = path.join(directory, "openshell-gateway");
      expect(spawnSync("mkfifo", [fifoPath], { timeout: 1_000 }).status).toBe(0);

      expect(
        inspectServiceFileIdentity({
          expectedUid: CURRENT_UID,
          filePath: fifoPath,
          hashContents: true,
        }),
      ).toBeNull();
    },
  );

  it("rejects a regular file that is owned by another user (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n");

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      fstatSync: (fileDescriptor) =>
        fileStat(fs.fstatSync(fileDescriptor, { bigint: true }), {
          uid: BigInt(CURRENT_UID + 1),
        }),
    });

    expect(inspection).toBeNull();
  });

  it("rejects a file that does not have every required mode bit (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n", { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);

    expect(
      inspectServiceFileIdentity({
        expectedUid: CURRENT_UID,
        filePath,
        requiredModeBits: 0o100,
      }),
    ).toBeNull();
  });

  it.each([
    ["group-writable", 0o775],
    ["world-writable", 0o757],
  ])("rejects a %s regular file (#9705)", (_case, mode) => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n", { mode });
    fs.chmodSync(filePath, mode);

    expect(
      inspectServiceFileIdentity({
        expectedUid: CURRENT_UID,
        filePath,
        requiredModeBits: 0o100,
      }),
    ).toBeNull();
  });

  it("rejects an empty file when executable mode is required (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "", { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);

    expect(
      inspectServiceFileIdentity({
        expectedUid: CURRENT_UID,
        filePath,
        requiredModeBits: 0o100,
      }),
    ).toBeNull();
  });

  it("closes the descriptor when metadata inspection fails (#9705)", () => {
    const filePath = path.join(directory, "openshell-gateway");
    fs.writeFileSync(filePath, "reviewed executable\n");
    let openedDescriptor: number | undefined;

    const inspection = inspectServiceFileIdentity({
      expectedUid: CURRENT_UID,
      filePath,
      fstatSync: () => {
        throw new Error("private metadata must not escape");
      },
      openSync: (candidate, flags) => {
        openedDescriptor = fs.openSync(candidate, flags);
        return openedDescriptor;
      },
    });

    expect(inspection).toBeNull();
    expect(openedDescriptor).toBeDefined();
    expect(() => fs.fstatSync(openedDescriptor as number)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
  });
});
