// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRealOpenClawWorkerDirectory } from "../../helpers/openclaw-real-worker-directory";

const helper = path.resolve(
  import.meta.dirname,
  "../../../scripts/lib/patch-openclaw-worker-archive.py",
);
const exerciseArchive = String.raw`
import gzip, importlib.util, io, json, sys, tarfile
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
scenario = sys.argv[2]
names = sorted(worker.ENTRYPOINTS | worker.MODULES)
if scenario == "missing": names.remove("worker.mjs")
if scenario == "duplicate": names.append(names[0])
if scenario == "traversal": names.append("../escape.mjs")
if scenario == "absolute": names.append("/escape.mjs")
if scenario == "unexpected": names.append("unexpected.mjs")
if scenario == "count": names.extend(f"worker-chunk-extra-{i}.mjs" for i in range(6001))
stream = io.BytesIO()
with tarfile.open(fileobj=stream, mode="w:gz") as archive:
    for index, name in enumerate(names):
        entry = tarfile.TarInfo(name)
        entry.mode = 0o700
        if index == 0 and scenario in ("symlink", "hardlink"):
            entry.type = tarfile.SYMTYPE if scenario == "symlink" else tarfile.LNKTYPE
            entry.linkname = "/outside"
        if index == 0 and scenario == "mode": entry.mode = 0o777
        archive.addfile(entry)
data = stream.getvalue()
if scenario == "size":
    entry = tarfile.TarInfo(names[0])
    entry.mode = 0o700
    entry.size = 64 * 1024 * 1024 + 1
    data = gzip.compress(entry.tobuf() + bytes(1024))
try:
    result = worker.read_archive(data)
    print(json.dumps({"accepted": True, "entries": len(result)}))
except ValueError as error:
    print(json.dumps({"accepted": False, "error": str(error)}))
if len(sys.argv) > 3:
    from pathlib import Path
    root = Path(sys.argv[3])
    dist = root / "dist"
    artifacts = dist / "worker-artifacts"
    artifacts.mkdir(parents=True)
    digest = worker.manifest_hash({name: worker.file_identity(value) for name, value in result.items()})
    if sys.argv[4] == "manifest": digest = "0" * 64
    name = digest + ".tar.gz"
    (root / "package.json").write_text(json.dumps({"version": "2026.10.5"}))
    (dist / "postinstall-inventory.json").write_text(json.dumps([] if sys.argv[4] == "inventory" else ["dist/worker-artifacts/" + name]))
    if sys.argv[4] == "symlink":
        (root / "outside.tar.gz").write_bytes(data)
        (artifacts / name).symlink_to(root / "outside.tar.gz")
    else:
        (artifacts / name).write_bytes(data)
`;

describe("OpenClaw worker archive admission", () => {
  it.each([
    ["valid", true],
    ["missing", false],
    ["duplicate", false],
    ["traversal", false],
    ["absolute", false],
    ["unexpected", false],
    ["symlink", false],
    ["hardlink", false],
    ["mode", false],
    ["size", false],
    ["count", false],
  ] as const)("classifies %s before publication", (scenario, accepted) => {
    const result = spawnSync("python3", ["-c", exerciseArchive, helper, scenario], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).accepted).toBe(accepted);
  });

  describe("manifest-verified staging", () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-stage-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const createFixture = (scenario: string) =>
      spawnSync("python3", ["-c", exerciseArchive, helper, "valid", root, scenario], {
        encoding: "utf8",
        timeout: 10_000,
      });
    const stage = () =>
      prepareRealOpenClawWorkerDirectory({
        dist: path.join(root, "dist"),
        tmp: root,
        timeoutMs: 10_000,
      });

    it("stages a valid archive privately without populating the distribution", () => {
      const fixture = createFixture("valid");
      expect(fixture.status, fixture.stderr).toBe(0);
      const staged = stage();
      expect(staged.archived).toBe(true);
      expect(fs.readFileSync(path.join(staged.directory, "worker.mjs"))).toHaveLength(0);
      expect(fs.statSync(staged.directory).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(root, "dist", "worker"))).toBe(false);
    });

    it.each(["manifest", "inventory", "symlink"])(
      "rejects an unverified %s without leaving a staging directory",
      (scenario) => {
        const fixture = createFixture(scenario);
        expect(fixture.status, fixture.stderr).toBe(0);
        expect(stage).toThrow("Could not stage reviewed worker archive");
        expect(fs.readdirSync(root).filter((name) => name.startsWith("worker-proof-"))).toEqual([]);
      },
    );
  });
});
