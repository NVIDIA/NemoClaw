// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalPathFromHandle,
  resolveMissingSqlitePath,
  workspacePathFromHandle,
  type CanonicalPathApi,
} from "./sqlite-canonical-path.mts";
import { compileSqliteCanonicalRuntime } from "./sqlite-canonical-path-build.mts";

function nativeFixture(value = "\\Device\\HarddiskVolume4\\state\\agent.sqlite") {
  let closed = 0;
  let opened = 0;
  const api: CanonicalPathApi = {
    open: () => {
      opened += 1;
      return 42;
    },
    invalid: () => false,
    finalPath: (_handle, output, volume = 2) => {
      const name = volume === 4 ? value.replace(/^\\Device\\[^\\]+/u, "") : value;
      output.write(name, "utf16le");
      return name.length;
    },
    close: () => {
      closed += 1;
      return true;
    },
    lastError: () => 5,
  };
  return { api, counts: () => ({ opened, closed }) };
}

test("SQLite canonical names retain the handle-resolved NT namespace and close the handle", () => {
  const fixture = nativeFixture();
  assert.equal(
    canonicalPathFromHandle("C:\\state\\agent.sqlite", fixture.api),
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume4\\state\\agent.sqlite",
  );
  assert.deepEqual(fixture.counts(), { opened: 1, closed: 1 });
});

test("SQLite canonical lookup preserves access denial and missing-path errors", () => {
  for (const [status, code] of [
    [5, "EPERM"],
    [2, "ENOENT"],
    [3, "ENOENT"],
    [1921, "ELOOP"],
    [9999, "EIO"],
  ] as const) {
    const fixture = nativeFixture();
    fixture.api.invalid = () => true;
    fixture.api.lastError = () => status;
    assert.throws(() => canonicalPathFromHandle("C:\\state", fixture.api), {
      code,
      syscall: "realpath",
      path: "C:\\state",
    });
    assert.deepEqual(fixture.counts(), { opened: 1, closed: 0 });
  }
});

test("SQLite canonical lookup rejects incomplete output and unexpected namespaces", () => {
  for (const result of [0, 32768, -1, 1.5]) {
    const fixture = nativeFixture();
    fixture.api.finalPath = () => result;
    assert.throws(() => canonicalPathFromHandle("C:\\state", fixture.api));
    assert.equal(fixture.counts().closed, 1);
  }
  for (const value of ["C:\\state", "\\Device\\volume\0tail"]) {
    const fixture = nativeFixture(value);
    assert.throws(() => canonicalPathFromHandle("C:\\state", fixture.api), { code: "EIO" });
    assert.equal(fixture.counts().closed, 1);
  }
  const fixture = nativeFixture();
  assert.throws(() => canonicalPathFromHandle("C:\\state\0tail", fixture.api), TypeError);
  assert.deepEqual(fixture.counts(), { opened: 0, closed: 0 });
});

test("SQLite canonical lookup reports a failed handle close", () => {
  const fixture = nativeFixture();
  fixture.api.close = () => false;
  assert.throws(() => canonicalPathFromHandle("C:\\state", fixture.api), { code: "EPERM" });
});

test("missing SQLite paths resolve from the nearest existing directory without probing ancestors", () => {
  const visited: string[] = [];
  const root = "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume4\\state";
  const filesystem = {
    lstatSync: (value: string) => {
      visited.push(value);
      if (value !== root) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    readlinkSync: () => {
      throw new Error("No link read is expected");
    },
  } as unknown as Pick<typeof fs, "lstatSync" | "readlinkSync">;
  const target = path.win32.join(root, "imports", "archive.sqlite");
  assert.deepEqual(resolveMissingSqlitePath(target, filesystem, path.win32), {
    existingPath: root,
    unresolvedSegments: ["imports", "archive.sqlite"],
  });
  assert.deepEqual(visited, [target, path.win32.join(root, "imports"), root]);
});

test("missing SQLite paths propagate forbidden ancestor access without a lexical fallback", () => {
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  const filesystem = {
    lstatSync: () => {
      throw denied;
    },
  } as unknown as Pick<typeof fs, "lstatSync" | "readlinkSync">;
  assert.throws(
    () => resolveMissingSqlitePath("C:\\state\\imports", filesystem, path.win32),
    (error) => error === denied,
  );
});

test("missing SQLite path resolution preserves dangling links, suffixes and link cycles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-path-"));
  try {
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    assert.deepEqual(resolveMissingSqlitePath(path.join(state, "imports", "archive")), {
      existingPath: state,
      unresolvedSegments: ["imports", "archive"],
    });
    if (process.platform !== "win32") {
      fs.symlinkSync("state/missing", path.join(root, "dangling"));
      assert.deepEqual(resolveMissingSqlitePath(path.join(root, "dangling", "archive")), {
        existingPath: state,
        unresolvedSegments: ["missing", "archive"],
      });
      fs.symlinkSync("cycle-b", path.join(root, "cycle-a"));
      fs.symlinkSync("cycle-a", path.join(root, "cycle-b"));
      assert.throws(() => resolveMissingSqlitePath(path.join(root, "cycle-a", "archive")), {
        code: "ELOOP",
      });
      const dotted = state + "/missing/../archive";
      assert.deepEqual(resolveMissingSqlitePath(dotted), {
        existingPath: state,
        unresolvedSegments: ["missing", "..", "archive"],
      });
    }
    const file = path.join(state, "file");
    fs.writeFileSync(file, "retained");
    assert.throws(() => resolveMissingSqlitePath(path.join(file, "child")));
    assert.equal(fs.readFileSync(file, "utf8"), "retained");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite adaptation refuses a changed pinned source and leaves other modules untouched", () => {
  assert.throws(
    () =>
      compileSqliteCanonicalRuntime("dist/openclaw-agent-db-maintenance-wTIy-jt-.js", "changed"),
    /reviewed SQLite/u,
  );
  assert.equal(compileSqliteCanonicalRuntime("dist/unrelated.js", "unchanged"), "unchanged");
});

test("workspace canonical adaptation refuses changed upstream permission-root code", () => {
  assert.throws(
    () => compileSqliteCanonicalRuntime("dist/builtin-openclaw-B_H1oNzF.js", "changed"),
    /reviewed SQLite/u,
  );
});

test("workspace roots use volume-relative names only after verifying the drive handle", () => {
  const fixture = nativeFixture("\\Device\\HarddiskVolume4\\workspace");
  assert.equal(workspacePathFromHandle("C:\\alias", fixture.api), "C:\\workspace");
  assert.deepEqual(fixture.counts(), { opened: 3, closed: 3 });
  fixture.api.open = (pathname) => pathname;
  fixture.api.invalid = (handle) => handle !== "C:\\junction" && handle !== "D:\\workspace";
  assert.equal(workspacePathFromHandle("C:\\junction", fixture.api), "D:\\workspace");
});

test("workspace roots propagate original access denial and reject inaccessible drive candidates", () => {
  const fixture = nativeFixture();
  fixture.api.invalid = () => true;
  assert.throws(() => workspacePathFromHandle("C:\\workspace", fixture.api), { code: "EPERM" });
  let opened = 0;
  fixture.api.open = () => ++opened;
  fixture.api.invalid = (handle) => Number(handle) > 2;
  assert.throws(() => workspacePathFromHandle("C:\\workspace", fixture.api), { code: "EIO" });
  assert.equal(opened, 28);
});

test("workspace drive mapping rejects a changed target identity", () => {
  const fixture = nativeFixture("\\Device\\HarddiskVolume4\\workspace");
  let calls = 0;
  fixture.api.finalPath = (_handle, output, volume = 2) => {
    calls += 1;
    const value =
      volume === 4
        ? "\\workspace"
        : calls === 1
          ? "\\Device\\HarddiskVolume4\\workspace"
          : "\\Device\\HarddiskVolume4\\elsewhere";
    output.write(value, "utf16le");
    return value.length;
  };
  assert.throws(() => workspacePathFromHandle("C:\\workspace", fixture.api), { code: "EIO" });
  assert.deepEqual(fixture.counts(), { opened: 28, closed: 28 });
});

test("volume-relative workspace names reject an unexpected namespace", () => {
  const fixture = nativeFixture();
  const original = fixture.api.finalPath;
  for (const value of ["C:\\workspace", "\\\\server\\workspace", "\\workspace\0tail"]) {
    fixture.api.finalPath = (handle, output, volume) => {
      if (volume !== 4) return original(handle, output, volume);
      output.write(value, "utf16le");
      return value.length;
    };
    assert.throws(() => workspacePathFromHandle("C:\\workspace", fixture.api), { code: "EIO" });
  }
});
