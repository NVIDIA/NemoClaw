// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  patchPluginSourceRoot,
  patchPluginSourceVerification,
} from "../../../scripts/lib/patch-openclaw-plugin-source-root.mts";

const fixture = `function withPluginSourceFile(source, boundary, read) {
\tconst opened = openRootFileSync$1({
    absolutePath: source, rootPath: boundary, boundaryLabel: "plugin build source", rejectHardlinks: false
  });
  if (!opened.ok) throw new Error("Cannot capture plugin source", { cause: opened.error });
  try { return read(opened.fd); } finally { fs.closeSync(opened.fd); }
}`;
const legacyFixture = fixture
  .replace(
    "withPluginSourceFile(source, boundary, read)",
    "readPluginSourceBytes(source, boundary)",
  )
  .replace("openRootFileSync$1", "openRootFileSync")
  .replace("read(opened.fd)", "fs.readFileSync(opened.fd)");

function runtime(
  platform: string,
  native = vi.fn(() => "/canonical/root"),
  opened = { ok: true, fd: 17, error: undefined as Error | undefined },
  version = "2026.10.5",
) {
  const open = vi.fn((_options: { rootRealPath?: string }) => opened);
  const close = vi.fn();
  const bytes = vi.fn((fd: number) => Buffer.from(`read:${fd}`));
  const source = version === "2026.9.5" ? legacyFixture : fixture;
  const read = vm.runInNewContext(`(${patchPluginSourceRoot(source, version)})`, {
    process: { platform },
    path,
    fs: { realpathSync: { native }, closeSync: close, readFileSync: bytes },
    openRootFileSync: open,
    openRootFileSync$1: open,
  });
  return { native, open, close, read, bytes };
}

describe("OpenClaw plugin source root admission", () => {
  it.each(["2026.9.5", "2026.9.7"])(
    "preserves the migration bridge's guarded read and descriptor cleanup on %s",
    (version) => {
      const proof = runtime(
        "linux",
        vi.fn(() => "/canonical/root"),
        undefined,
        version,
      );
      const callback = vi.fn((fd: number) => Buffer.from(`read:${fd}`));
      expect(proof.read("source", "root/../boundary", callback).toString()).toBe("read:17");
      expect(proof.open).toHaveBeenCalledWith({
        absolutePath: "source",
        rootPath: "root/../boundary",
        boundaryLabel: "plugin build source",
        rejectHardlinks: false,
        rootRealPath: "/canonical/root",
      });
      expect(proof.native).toHaveBeenCalledExactlyOnceWith(path.resolve("root/../boundary"));
      expect(proof.close).toHaveBeenCalledExactlyOnceWith(17);
      expect(version === "2026.9.5" ? proof.bytes : callback).toHaveBeenCalledExactlyOnceWith(17);
    },
  );

  it("closes the 9.5 bridge descriptor when reading its bytes fails", () => {
    const proof = runtime(
      "linux",
      vi.fn(() => "/canonical/root"),
      undefined,
      "2026.9.5",
    );
    const failure = new Error("read failed");
    proof.bytes.mockImplementation(() => {
      throw failure;
    });
    expect(() => proof.read("source", "boundary")).toThrow(failure);
    expect(proof.close).toHaveBeenCalledExactlyOnceWith(17);
  });

  it.each(["2026.9.5", "2026.9.7", "2026.10.5"])(
    "accepts only a complete, idempotent patch for %s",
    (version) => {
      const source = version === "2026.9.5" ? legacyFixture : fixture;
      const patched = patchPluginSourceRoot(source, version);
      expect(patchPluginSourceRoot(patched, version)).toBe(patched);
      expect(() => patchPluginSourceRoot("unrecognized native module", version)).toThrow(
        "boundary",
      );
      expect(() => patchPluginSourceRoot(source + source, version)).toThrow("boundary");
      expect(() => patchPluginSourceRoot(patched + source, version)).toThrow("Incomplete");
    },
  );

  it("refuses an unreviewed runtime before transforming its source", () => {
    expect(() => patchPluginSourceRoot(fixture, "2026.10.6")).toThrow("Unsupported");
    expect(() => patchPluginSourceRoot(fixture, "2026.9.5")).toThrow("boundary");
  });

  it.each(["linux", "darwin", "win32"])(
    "retains the guarded-open inputs and descriptor lifetime on %s",
    (platform) => {
      const proof = runtime(platform);
      const callback = vi.fn((fd: number) => `read:${fd}`);
      expect(proof.read("raw/../source", "root/../boundary", callback)).toBe("read:17");
      expect(proof.open).toHaveBeenCalledWith({
        absolutePath: "raw/../source",
        rootPath: "root/../boundary",
        boundaryLabel: "plugin build source",
        rejectHardlinks: false,
        rootRealPath: platform === "linux" ? "/canonical/root" : undefined,
      });
      expect(proof.native).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0);
      expect(callback).toHaveBeenCalledWith(17);
      expect(proof.close).toHaveBeenCalledExactlyOnceWith(17);
    },
  );

  it("resolves the normalized root freshly for every admission", () => {
    const native = vi.fn().mockReturnValueOnce("/first").mockReturnValueOnce("/second");
    const proof = runtime("linux", native);
    proof.read("source", "root/../boundary", () => undefined);
    proof.read("source", "root/../boundary", () => undefined);
    expect(native).toHaveBeenNthCalledWith(1, path.resolve("root/../boundary"));
    expect(native).toHaveBeenNthCalledWith(2, path.resolve("root/../boundary"));
    expect(proof.open.mock.calls.map((call) => call[0].rootRealPath)).toEqual([
      "/first",
      "/second",
    ]);
  });

  it("falls back to the original guarded resolver when native canonicalization fails", () => {
    const native = vi.fn(() => {
      throw new Error("native lookup failed");
    });
    const proof = runtime("linux", native);
    expect(proof.read("source", "boundary", () => "read")).toBe("read");
    expect(proof.open).toHaveBeenCalledWith({
      absolutePath: "source",
      rootPath: "boundary",
      boundaryLabel: "plugin build source",
      rejectHardlinks: false,
      rootRealPath: undefined,
    });
    expect(proof.close).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("propagates guarded-open rejection without consuming a descriptor", () => {
    const error = new Error("guarded admission denied");
    const proof = runtime(
      "linux",
      vi.fn(() => "/canonical/root"),
      { ok: false, fd: 17, error },
    );
    const callback = vi.fn();
    expect(() => proof.read("source", "boundary", callback)).toThrow(
      expect.objectContaining({ cause: error }),
    );
    expect(callback).not.toHaveBeenCalled();
    expect(proof.close).not.toHaveBeenCalled();
  });

  it("closes the pinned descriptor when its consumer throws", () => {
    const proof = runtime("linux");
    const failure = new Error("consumer failed");
    expect(() =>
      proof.read("source", "boundary", () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(proof.close).toHaveBeenCalledExactlyOnceWith(17);
  });
});

const verificationFixture = `function verifyPluginSourceInputs(inputs, sources) {
  for (const source of sources) {
    const input = inputs.get(source), identity = input.actualIdentity;
    if (fs.realpathSync(source) !== source || identity !== input.identity || !input.contentValid)
      throw new Error("source changed");
  }
}
function createRetainedSourceVerification(root, sources) {
  return () => {
    for (const { source, input } of sources) {
\t\t\tconst canonical = fs.realpathSync(source);
      verifyPluginSourceInputs(new Map([[canonical, input]]), [canonical]);
    }
  };
}`;

function verificationRuntime(platform: string, native: (source: string) => string) {
  const original = vi.fn((source: string) => source);
  const nativeLookup = vi.fn(native);
  const functions = vm.runInNewContext(
    patchPluginSourceVerification(verificationFixture) +
      "; ({ resolve: freshCanonicalPluginSource, verify: verifyPluginSourceInputs, retain: createRetainedSourceVerification })",
    {
      process: { platform },
      fs: { realpathSync: Object.assign(original, { native: nativeLookup }) },
    },
  );
  return { ...functions, original, nativeLookup };
}

describe("OpenClaw source verification canonical paths", () => {
  it.each(["linux", "darwin", "win32"])(
    "keeps the existing resolver on %s unless a fresh Linux lookup proves the input canonical",
    (platform) => {
      const proof = verificationRuntime(platform, (source) => source);
      expect(proof.resolve("/canonical/file")).toBe("/canonical/file");
      expect(proof.nativeLookup).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0);
      expect(proof.original).toHaveBeenCalledTimes(platform === "linux" ? 0 : 1);
    },
  );

  it("uses original alias resolution and preserves its error", () => {
    const proof = verificationRuntime("linux", () => "/physical/target");
    proof.original.mockReturnValueOnce("/original/target");
    expect(proof.resolve("/alias")).toBe("/original/target");
    expect(proof.original).toHaveBeenCalledExactlyOnceWith("/alias");
    const error = new Error("original resolver rejected alias");
    proof.original.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => proof.resolve("/alias")).toThrow(error);
  });

  it("falls back after native failure and never caches a previous observation", () => {
    const proof = verificationRuntime("linux", (source) => source);
    expect(proof.resolve("/file")).toBe("/file");
    proof.nativeLookup.mockImplementationOnce(() => {
      throw new Error("native unavailable");
    });
    proof.original.mockReturnValueOnce("/changed");
    expect(proof.resolve("/file")).toBe("/changed");
    expect(proof.nativeLookup).toHaveBeenCalledTimes(2);
    expect(proof.original).toHaveBeenCalledExactlyOnceWith("/file");
  });

  it("retains identity and content checks after a canonical lookup and source adoption", () => {
    const proof = verificationRuntime("linux", (source) => source);
    const input = { identity: "initial", actualIdentity: "initial", contentValid: true };
    const retained = proof.retain({}, [{ source: "/file", input }]);
    expect(retained).not.toThrow();
    input.actualIdentity = "replacement";
    expect(retained).toThrow("source changed");
    input.actualIdentity = "initial";
    input.contentValid = false;
    expect(() => proof.verify(new Map([["/file", input]]), ["/file"])).toThrow("source changed");
  });

  it.each(["missing", "duplicate", "mixed", "partial"] as const)(
    "refuses a %s verification patch without weakening its source guards",
    (scenario) => {
      const patched = patchPluginSourceVerification(verificationFixture);
      const sources = {
        missing: "",
        duplicate: verificationFixture + verificationFixture,
        mixed: patched + verificationFixture,
        partial: patched.replace(
          "const canonical = freshCanonicalPluginSource(source);",
          "const canonical = fs.realpathSync(source);",
        ),
      };
      expect(() => patchPluginSourceVerification(sources[scenario])).toThrow("boundary");
    },
  );

  it("accepts a complete patch idempotently and rejects duplicated helpers", () => {
    const patched = patchPluginSourceVerification(verificationFixture);
    expect(patchPluginSourceVerification(patched)).toBe(patched);
    expect(() => patchPluginSourceVerification(patched + patched)).toThrow("Incomplete");
  });
});
