// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NVIDIA_CDI_INSTALL_SCRIPT, WSL_NVIDIA_CDI_PREPARE_SCRIPT } from "./script";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cdi-unit-"));
  roots.push(root);
  const toolkit = path.join(root, "toolkit");
  fs.writeFileSync(
    toolkit,
    `#!/bin/sh
set -eu
if [ "$2" = generate ]; then
  if [ -e "$FIXTURE_ROOT/concurrent" ]; then
    /bin/sh "$FIXTURE_ROOT/install.sh" "$FIXTURE_ROOT" "$0" "$(id -u)" 1 > "$FIXTURE_ROOT/concurrent-result" 2>&1 && exit 14
  fi
  if [ -e "$FIXTURE_ROOT/directory-race" ]; then mkdir "$FIXTURE_ROOT/cdi/nemoclaw-nvidia.yaml"; fi
  printf 'cdiVersion: "0.3.0"\\nkind: nvidia.com/gpu\\n'
  [ ! -e "$FIXTURE_ROOT/fail-generation" ] || exit 13
elif [ "$2" = list ]; then
  if [ -e "$FIXTURE_ROOT/operator-cdi" ]; then printf 'nvidia.com/gpu=all\\n'; fi
  if [ -e "$FIXTURE_ROOT/cdi/nemoclaw-nvidia.yaml" ] && [ ! -e "$FIXTURE_ROOT/reject-spec" ]; then
    printf 'nvidia.com/gpu=all\\n'
  fi
else exit 12; fi
`,
    { mode: 0o700 },
  );
  const file = path.join(root, "cdi/nemoclaw-nvidia.yaml");
  const state = path.join(root, "nemoclaw-nvidia-cdi");
  fs.writeFileSync(path.join(root, "install.sh"), NVIDIA_CDI_INSTALL_SCRIPT);
  const run = (generationAllowed = "1") =>
    spawnSync(
      "/bin/sh",
      ["-s", "--", root, toolkit, String(process.getuid?.()), generationAllowed],
      {
        input: NVIDIA_CDI_INSTALL_SCRIPT,
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: "/usr/bin:/bin", FIXTURE_ROOT: root },
      },
    );
  return { root, file, state, run };
}

describe("NVIDIA CDI daemon-filesystem transaction", () => {
  it("parses the complete WSL daemon program as a shell script", () => {
    const result = spawnSync("/bin/sh", ["-n"], {
      input: WSL_NVIDIA_CDI_PREPARE_SCRIPT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("publishes a complete spec and reuses it without changing the file", () => {
    const f = fixture();
    const first = f.run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe("NEMOCLAW_CDI_PREPARED");
    const descriptor = fs.openSync(f.file, "r");
    let identity: fs.Stats;
    try {
      identity = fs.fstatSync(descriptor);
      expect(fs.readFileSync(descriptor, "utf8")).toEqual(
        fs.readFileSync(path.join(f.state, "spec.yaml"), "utf8"),
      );
      expect(identity.mode & 0o777).toBe(0o644);
    } finally {
      fs.closeSync(descriptor);
    }
    const second = f.run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trim()).toBe("NEMOCLAW_CDI_EXISTING");
    expect(fs.statSync(f.file).ino).toBe(identity.ino);
    expect(fs.readdirSync(path.dirname(f.file))).toEqual(["nemoclaw-nvidia.yaml"]);
    expect(fs.existsSync(path.join(f.state, "lock"))).toBe(false);
  });
  it("refuses a discovered specification until its writer commits", () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.file), { mode: 0o755 });
    fs.writeFileSync(f.file, "published but uncommitted");
    fs.mkdirSync(path.join(f.state, "lock"), { recursive: true, mode: 0o700 });
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active or interrupted");
    expect(fs.readFileSync(f.file, "utf8")).toBe("published but uncommitted");
    expect(fs.existsSync(path.join(f.state, "lock"))).toBe(true);
  });
  it("does not generate if previously discovered CDI disappears before verification", () => {
    const f = fixture();
    const result = f.run("0");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no generation was authorized");
    expect(fs.existsSync(f.state)).toBe(false);
    expect(fs.existsSync(f.file)).toBe(false);
  });
  it("preserves an existing operator inventory without creating state", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "operator-cdi"), "operator");
    expect(f.run().status).toBe(0);
    expect(fs.existsSync(f.state)).toBe(false);
    expect(fs.existsSync(f.file)).toBe(false);
  });
  it.each(["fail-generation", "reject-spec"])("removes partial owned files after %s", (failure) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, failure), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readdirSync(f.state)).toEqual([]);
    expect(fs.readdirSync(path.dirname(f.file))).toEqual([]);
  });
  it("preserves an unrecognized existing file and stops", () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.file), { mode: 0o755 });
    fs.writeFileSync(f.file, "operator-owned");
    fs.writeFileSync(path.join(f.root, "reject-spec"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prior CDI state needs inspection");
    expect(fs.readFileSync(f.file, "utf8")).toBe("operator-owned");
  });
  it("preserves an interrupted operation's receipt", () => {
    const f = fixture();
    fs.mkdirSync(f.state, { mode: 0o700 });
    fs.writeFileSync(path.join(f.state, "spec.yaml"), "retained evidence");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prior CDI state needs inspection");
    expect(fs.readFileSync(path.join(f.state, "spec.yaml"), "utf8")).toBe("retained evidence");
  });
  it.each(["cdi", "nemoclaw-nvidia-cdi"])(
    "rejects a symlink at %s without writing through it",
    (directory) => {
      const f = fixture();
      const other = path.join(f.root, "other");
      fs.mkdirSync(other);
      fs.symlinkSync(other, path.join(f.root, directory));
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("CDI directory is not a regular directory");
      expect(fs.readdirSync(other)).toEqual([]);
    },
  );
  it("does not acquire or remove another operation's lock", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.state, "lock"), { recursive: true, mode: 0o700 });
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active or interrupted");
    expect(fs.existsSync(path.join(f.state, "lock"))).toBe(true);
    expect(fs.existsSync(f.file)).toBe(false);
  });
  it("rejects writable shared state", () => {
    const f = fixture();
    fs.mkdirSync(f.state, { mode: 0o700 });
    fs.chmodSync(f.state, 0o777);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CDI directory permissions are unsafe");
    expect(fs.existsSync(f.file)).toBe(false);
  });
  it("allows one writer when a second process attempts preparation during generation", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "concurrent"), "");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(f.root, "concurrent-result"), "utf8")).toContain(
      "active or interrupted",
    );
    expect(fs.readdirSync(path.dirname(f.file))).toEqual(["nemoclaw-nvidia.yaml"]);
    expect(fs.existsSync(path.join(f.state, "lock"))).toBe(false);
  });
  it("does not publish inside an operator directory created during generation", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "directory-race"), "");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("retained for inspection");
    expect(fs.statSync(f.file).isDirectory()).toBe(true);
    expect(fs.readdirSync(f.file)).toEqual([]);
    expect(fs.readdirSync(path.dirname(f.file))).toEqual(["nemoclaw-nvidia.yaml"]);
    expect(fs.existsSync(path.join(f.state, "spec.yaml"))).toBe(true);
  });
});
