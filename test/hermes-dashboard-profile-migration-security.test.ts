// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "seed-dashboard-config.py",
);

let tmpDir: string;

function runPreparation(destination: string, fault: string, mergeLegacy = true) {
  const harness = `
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("seed_dashboard_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

${fault}

ok, dashboard_fd = module._prepare_dashboard_destination(
    sys.argv[2], merge_legacy=sys.argv[3] == "true"
)
if dashboard_fd is not None:
    os.close(dashboard_fd)
raise SystemExit(0 if not ok and dashboard_fd is None else 2)
`;
  return spawnSync("python3", ["-c", harness, SCRIPT_PATH, destination, String(mergeLegacy)], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
}

describe("Hermes dashboard profile migration security", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-migration-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not replace a destination recreated before the whole-profile move (#7200)", () => {
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");

    const fault = `
original_rename = module._rename_no_replace_at
def recreate_destination(src_fd, name, dst_fd):
    os.mkdir(name, dir_fd=dst_fd)
    created_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY, dir_fd=dst_fd)
    try:
        marker_fd = os.open("CURRENT.md", os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=created_fd)
        os.write(marker_fd, b"current\\n")
        os.close(marker_fd)
    finally:
        os.close(created_fd)
    original_rename(src_fd, name, dst_fd)
module._rename_no_replace_at = recreate_destination
`;
    const res = runPreparation(path.join(dashboardHome, "config.yaml"), fault, false);

    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(legacyHome, "MEMORY.md"), "utf-8")).toBe("legacy\n");
    expect(fs.readFileSync(path.join(dashboardHome, "CURRENT.md"), "utf-8")).toBe("current\n");
  });

  it("rolls back earlier entries when a later merge move fails (#7200)", () => {
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "A.md"), "a\n");
    fs.writeFileSync(path.join(legacyHome, "B.md"), "b\n");
    fs.writeFileSync(path.join(dashboardHome, "CURRENT.md"), "current\n");

    const fault = `
import errno
original_rename = module._rename_no_replace_at
calls = 0
def fail_second_move(src_fd, name, dst_fd):
    global calls
    calls += 1
    if calls == 2:
        raise OSError(errno.EIO, "injected move failure")
    original_rename(src_fd, name, dst_fd)
module._rename_no_replace_at = fail_second_move
`;
    const res = runPreparation(path.join(dashboardHome, "config.yaml"), fault);

    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(legacyHome, "A.md"), "utf-8")).toBe("a\n");
    expect(fs.readFileSync(path.join(legacyHome, "B.md"), "utf-8")).toBe("b\n");
    expect(fs.readdirSync(dashboardHome)).toEqual(["CURRENT.md"]);
  });

  it("rolls back moved entries when the legacy directory removal fails (#7200)", () => {
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");
    fs.writeFileSync(path.join(dashboardHome, "CURRENT.md"), "current\n");

    const fault = `
import errno
original_rmdir = module.os.rmdir
def fail_legacy_removal(name, *args, **kwargs):
    if name == "dashboard-home":
        raise OSError(errno.ENOTEMPTY, "injected directory change")
    original_rmdir(name, *args, **kwargs)
module.os.rmdir = fail_legacy_removal
`;
    const res = runPreparation(path.join(dashboardHome, "config.yaml"), fault);

    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(legacyHome, "MEMORY.md"), "utf-8")).toBe("legacy\n");
    expect(fs.readdirSync(dashboardHome)).toEqual(["CURRENT.md"]);
  });
});
