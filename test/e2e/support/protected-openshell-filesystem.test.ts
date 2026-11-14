// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSource, safeFile } from "../../../tools/e2e/protected-openshell-filesystem.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

const helper = fs.readFileSync(
  new URL("../../../tools/e2e/protected-openshell-filesystem.py", import.meta.url),
  "utf8",
);
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "protected-fs-")));
  roots.push(parent);
  const root = join(parent, "trusted");
  const outside = join(parent, "outside");
  fs.mkdirSync(join(root, "nested"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(root, "nested/data"), "trusted bytes", { mode: 0o644 });
  fs.writeFileSync(join(outside, "data"), "external sentinel");
  return { root, outside, parent };
}

function probe(request: Record<string, unknown>, prelude: string) {
  return spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      `${prelude}\nexec(compile(${JSON.stringify(helper)}, "protected-filesystem", "exec"))`,
    ],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      env: {},
      timeout: 10_000,
    },
  );
}

it.each([0o600, 0o644, 0o755])(
  "reads and atomically replaces a protected file with mode %s",
  (mode) => {
    const { root } = fixture();
    expect(safeFile(root, "nested/data")).toMatchObject({ source: "trusted bytes", mode: 0o644 });
    replaceSource(root, "nested/data", "replacement bytes", mode, "trusted bytes");
    expect(safeFile(root, "nested/data")).toMatchObject({ source: "replacement bytes", mode });
    expect(fs.readdirSync(join(root, "nested"))).toEqual(["data"]);
  },
);

it("rejects a changed preimage without writing", () => {
  const { root } = fixture();
  expect(() => replaceSource(root, "nested/data", "replacement", 0o644, "stale bytes")).toThrow(
    /Unsafe/,
  );
  expect(safeFile(root, "nested/data").source).toBe("trusted bytes");
  expect(fs.readdirSync(join(root, "nested"))).toEqual(["data"]);
});

it.each(["../outside/data", "nested/../data", "/nested/data", "nested//data"])(
  "rejects non-repository destination %s",
  (path) => {
    const { root } = fixture();
    expect(() => safeFile(root, path)).toThrow(/Unsafe/);
    expect(() => replaceSource(root, path, "replacement", 0o644)).toThrow(/Unsafe/);
  },
);

it.each(["read", "replace"])("rejects a linked parent before %s", (operation) => {
  const { root, outside } = fixture();
  fs.renameSync(join(root, "nested"), join(root, "held"));
  fs.symlinkSync(outside, join(root, "nested"));
  const result = probe(
    { root, path: "nested/data", operation, source: "replacement", mode: 0o644 },
    "",
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("external sentinel");
  expect(fs.readFileSync(join(outside, "data"), "utf8")).toBe("external sentinel");
});

it.each([
  ["read", "parent"],
  ["read", "file"],
  ["replace", "parent"],
  ["replace", "file"],
  ["replace", "temporary"],
  ["replace", "rename"],
] as const)(
  "rejects %s after a directory swap at %s without touching the external destination",
  (operation, stage) => {
    const { root, outside } = fixture();
    const prelude = `import os
root = ${JSON.stringify(root)}
outside = ${JSON.stringify(outside)}
original_open = os.open
original_replace = os.replace
swapped = False

def swap():
    global swapped
    if not swapped:
        swapped = True
        os.rename(root + "/nested", root + "/held")
        os.symlink(outside, root + "/nested")

def opening(path, flags, *args, **kwargs):
    if (${JSON.stringify(stage)} == "parent" and path == "nested"
        or ${JSON.stringify(stage)} == "file" and path == "data"
        or ${JSON.stringify(stage)} == "temporary" and ".openshell-projection-" in str(path)):
        swap()
    return original_open(path, flags, *args, **kwargs)

def replacing(*args, **kwargs):
    if ${JSON.stringify(stage)} == "rename":
        swap()
    return original_replace(*args, **kwargs)

os.open = opening
os.replace = replacing`;
    const result = probe(
      {
        root,
        path: "nested/data",
        operation,
        source: "replacement",
        mode: 0o644,
        expectedSource: "trusted bytes",
      },
      prelude,
    );
    expect(result.status, result.stderr).not.toBe(0);
    expect(fs.readlinkSync(join(root, "nested"))).toBe(outside);
    expect(fs.readFileSync(join(outside, "data"), "utf8")).toBe("external sentinel");
    expect(result.stdout).not.toContain("external sentinel");
    expect(fs.readdirSync(outside)).toEqual(["data"]);
    expect(fs.readdirSync(join(root, "held"))).toEqual(["data"]);
  },
);

it("closes every opened descriptor when a hard-linked file is rejected", () => {
  const { root } = fixture();
  fs.linkSync(join(root, "nested/data"), join(root, "nested/alias"));
  const prelude = `import os, json, atexit
opened = []
closed = []
original_open = os.open
original_close = os.close

def opening(*args, **kwargs):
    descriptor = original_open(*args, **kwargs)
    opened.append(descriptor)
    return descriptor

def closing(descriptor):
    closed.append(descriptor)
    return original_close(descriptor)

os.open = opening
os.close = closing
atexit.register(lambda: print(json.dumps({"opened": opened, "closed": closed})))`;
  const result = probe({ root, path: "nested/data", operation: "read" }, prelude);
  expect(result.status).not.toBe(0);
  const descriptors = JSON.parse(result.stdout);
  expect(descriptors.opened.length).toBeGreaterThan(0);
  expect([...descriptors.closed].sort()).toEqual([...descriptors.opened].sort());
  expect(fs.readFileSync(join(root, "nested/data"), "utf8")).toBe("trusted bytes");
});

it("isolates filesystem subprocesses from inherited credentials and Python imports", () => {
  const { root } = fixture();
  vi.stubEnv("GITHUB_TOKEN", "synthetic-credential");
  vi.stubEnv("PYTHONPATH", "/untrusted/python");
  expect(safeFile(root, "nested/data").source).toBe("trusted bytes");
  const [executable, args, options] = vi.mocked(childProcess.execFileSync).mock.calls[0]!;
  expect(executable).toBe("/usr/bin/python3");
  expect(args?.slice(0, 3)).toEqual(["-I", "-S", "-c"]);
  expect(args?.join(" ")).not.toContain("synthetic-credential");
  expect(options).toMatchObject({ env: {}, stdio: ["pipe", "pipe", "pipe"] });
  expect(JSON.stringify(options)).not.toContain("synthetic-credential");
});

it.each(["read", "replace"])("rejects a detached trusted root during %s", (operation) => {
  const { root, outside } = fixture();
  const prelude = `import os
original_open = os.open
swapped = False

def opening(path, flags, *args, **kwargs):
    global swapped
    if path == "data" and not swapped:
        swapped = True
        os.rename(${JSON.stringify(root)}, ${JSON.stringify(root + ".held")})
        os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(root)})
    return original_open(path, flags, *args, **kwargs)

os.open = opening`;
  const result = probe(
    {
      root,
      path: "nested/data",
      operation,
      source: "replacement",
      mode: 0o644,
      expectedSource: "trusted bytes",
    },
    prelude,
  );
  expect(result.status).not.toBe(0);
  expect(fs.readlinkSync(root)).toBe(outside);
  expect(fs.readFileSync(join(outside, "data"), "utf8")).toBe("external sentinel");
  expect(fs.readFileSync(join(root + ".held", "nested/data"), "utf8")).toBe("trusted bytes");
});

it.each(["read", "replace"])(
  "rejects a linked leaf during %s even when its contents match",
  (operation) => {
    const { root, outside } = fixture();
    const external = join(outside, "data");
    fs.writeFileSync(external, "trusted bytes");
    const leaf = join(root, "nested/data");
    fs.unlinkSync(leaf);
    fs.symlinkSync(external, leaf);
    const result = probe(
      {
        root,
        path: "nested/data",
        operation,
        source: "replacement",
        mode: 0o644,
        expectedSource: "trusted bytes",
      },
      "",
    );
    expect(result.status).not.toBe(0);
    expect(fs.readlinkSync(leaf)).toBe(external);
    expect(fs.readFileSync(external, "utf8")).toBe("trusted bytes");
  },
);
