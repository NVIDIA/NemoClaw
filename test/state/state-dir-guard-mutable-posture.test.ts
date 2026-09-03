// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const PLAN = {
  version: 1,
  readOnlyRoots: ["profiles", "skills"],
  confidentialRoots: ["pairing"],
  readOnlyPrefixes: [],
  confidentialPrefixes: [],
  writableSubpaths: ["profiles/dashboard-home"],
};
const RUN_GUARD = String.raw`
import importlib.util
import json
import os
import sys

guard_path, action, config_dir, plan_json = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
immutable_inodes = set(os.environ.get("NEMOCLAW_TEST_IMMUTABLE_INODES", "").split(","))
append_only_inodes = set(os.environ.get("NEMOCLAW_TEST_APPEND_ONLY_INODES", "").split(","))
unavailable_inodes = set(os.environ.get("NEMOCLAW_TEST_FLAGS_UNAVAILABLE_INODES", "").split(","))
inode_flag_mutations = []
def fake_inode_flags(fd):
    inode = str(os.fstat(fd).st_ino)
    if inode in unavailable_inodes:
        return None
    flags = module.FS_IMMUTABLE_FL if inode in immutable_inodes else 0
    return flags | (module.FS_APPEND_FL if inode in append_only_inodes else 0)
module._get_inode_flags = fake_inode_flags
def record_inode_flag_mutation(fd, flags):
    inode_flag_mutations.append((os.fstat(fd).st_ino, flags))
module._set_inode_flags = record_inode_flag_mutation
swap_config_path = os.environ.get("NEMOCLAW_TEST_SWAP_CONFIG_PATH")
swap_old_path = os.environ.get("NEMOCLAW_TEST_SWAP_OLD_PATH")
real_verify_dir = module._verify_dir
swap_state = {"done": False}
def verify_dir_with_swap(*args, **kwargs):
    result = real_verify_dir(*args, **kwargs)
    if swap_config_path and swap_old_path and not swap_state["done"]:
        os.rename(swap_config_path, swap_old_path)
        os.mkdir(swap_config_path, 0o777)
        os.chmod(swap_config_path, 0o777)
        swap_state["done"] = True
    return result
module._verify_dir = verify_dir_with_swap
result = module.run_guard(
    action, config_dir, identity, module.parse_agent_state_lock_plan(plan_json),
    mutable_top_level_files=tuple(sys.argv[5:]),
    mutable_service_uids=(os.getuid(),)
    if os.environ.get("NEMOCLAW_TEST_MUTABLE_SERVICE_OWNER") == "1"
    else (),
)
for issue in result.issues:
    print(json.dumps(issue.as_json()))
print(json.dumps({"type": "test-observation", "inodeFlagMutationCalls": len(inode_flag_mutations)}))
print(json.dumps(result.summary_json()))
raise SystemExit(0 if result.ok else 1)
`;
let fixtureRoot: string | null = null;

function fixture(): { root: string; configDir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mutable-posture-")));
  fixtureRoot = root;
  const configDir = path.join(root, ".hermes");
  fs.mkdirSync(configDir);
  return { root, configDir: fs.realpathSync(configDir) };
}

function runGuard(
  action: "unlock" | "verify-mutable",
  configDir: string,
  env = {},
  topLevelFiles: string[] = [],
) {
  const result = spawnSync(
    "python3",
    ["-c", RUN_GUARD, GUARD_PATH, action, configDir, JSON.stringify(PLAN), ...topLevelFiles],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...result, lines };
}

function observeFixtureFile(filePath: string): {
  ino: number;
  mode: number;
  content: string;
} {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const observed = fs.fstatSync(fd);
    return { ino: observed.ino, mode: observed.mode, content: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

afterEach(() => {
  fixtureRoot && fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

describe("read-only recursive mutable posture observation", () => {
  it("accepts sandbox-owned 0700 Hermes config posture without mutation (#9485)", () => {
    const { root, configDir } = fixture();
    const configPath = path.join(configDir, "config.yaml");
    fs.writeFileSync(configPath, "config\n", { mode: 0o640 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(configDir, 0o700);
    const configDirBefore = fs.lstatSync(configDir);
    const configBefore = fs.lstatSync(configPath);

    const observed = runGuard(
      "verify-mutable",
      configDir,
      { NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1" },
      [configPath],
    );

    expect(observed.status, JSON.stringify(observed.lines)).toBe(0);
    expect(observed.lines).toContainEqual({
      type: "test-observation",
      inodeFlagMutationCalls: 0,
    });
    expect(observed.lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        action: "verify-mutable",
        status: "ok",
        issueCount: 0,
      }),
    );
    expect(fs.lstatSync(configDir)).toMatchObject({
      ino: configDirBefore.ino,
      mode: configDirBefore.mode,
    });
    expect(observeFixtureFile(configPath)).toMatchObject({
      ino: configBefore.ino,
      mode: configBefore.mode,
      content: "config\n",
    });
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "darwin")(
    "accepts a present private Hermes writable root without mutation (#9485)",
    () => {
      const { root, configDir } = fixture();
      const profilesDir = path.join(configDir, "profiles");
      const dashboardDir = path.join(profilesDir, "dashboard-home");
      fs.mkdirSync(dashboardDir, { recursive: true });
      fs.chmodSync(root, 0o755);
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(profilesDir, 0o2770);
      fs.chmodSync(dashboardDir, 0o700);
      const dashboardBefore = fs.lstatSync(dashboardDir);

      const observed = runGuard("verify-mutable", configDir, {
        NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
      });

      expect(observed.status).toBe(0);
      expect(observed.lines.at(-1)).toEqual(
        expect.objectContaining({
          type: "result",
          action: "verify-mutable",
          status: "ok",
          issueCount: 0,
        }),
      );
      expect(observed.lines).toContainEqual({
        type: "test-observation",
        inodeFlagMutationCalls: 0,
      });
      expect(fs.lstatSync(dashboardDir)).toMatchObject({
        ino: dashboardBefore.ino,
        mode: dashboardBefore.mode,
      });
      expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
    },
  );

  it("accepts Hermes service-owned mutable modes without changing them", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const skillDir = path.join(skillsDir, "bundled-skill");
    const skillFile = path.join(skillDir, "SKILL.md");
    const pairingDir = path.join(configDir, "pairing");
    const pairingFile = path.join(pairingDir, "state.json");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(pairingDir);
    fs.writeFileSync(skillFile, "skill\n", { mode: 0o644 });
    fs.writeFileSync(pairingFile, "pairing\n", { mode: 0o600 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(configDir, 0o700);
    fs.chmodSync(skillsDir, 0o775);
    fs.chmodSync(skillDir, 0o755);
    fs.chmodSync(pairingDir, 0o700);
    const before = [skillsDir, skillDir, skillFile, pairingDir, pairingFile].map((entry) =>
      fs.lstatSync(entry),
    );

    const observed = runGuard("verify-mutable", configDir, {
      NEMOCLAW_TEST_MUTABLE_SERVICE_OWNER: "1",
    });

    expect(observed.status, JSON.stringify(observed.lines)).toBe(0);
    expect(observed.lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        action: "verify-mutable",
        status: "ok",
        issueCount: 0,
      }),
    );
    expect(fs.lstatSync(skillsDir)).toMatchObject({ ino: before[0]?.ino, mode: before[0]?.mode });
    expect(fs.lstatSync(skillDir)).toMatchObject({ ino: before[1]?.ino, mode: before[1]?.mode });
    expect(fs.lstatSync(skillFile)).toMatchObject({ ino: before[2]?.ino, mode: before[2]?.mode });
    expect(fs.lstatSync(pairingDir)).toMatchObject({ ino: before[3]?.ino, mode: before[3]?.mode });
    expect(fs.lstatSync(pairingFile)).toMatchObject({ ino: before[4]?.ino, mode: before[4]?.mode });
  });

  it("rejects world-writable Hermes service state without changing it", () => {
    const { configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const skillFile = path.join(skillsDir, "state.json");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(skillFile, "state\n", { mode: 0o666 });
    fs.chmodSync(skillsDir, 0o777);
    fs.chmodSync(skillFile, 0o666);
    const dirBefore = fs.lstatSync(skillsDir);
    const fileBefore = fs.lstatSync(skillFile);

    const observed = runGuard("verify-mutable", configDir, {
      NEMOCLAW_TEST_MUTABLE_SERVICE_OWNER: "1",
    });

    expect(observed.status).toBe(1);
    expect(observed.lines).toEqual(
      expect.arrayContaining(
        [skillsDir, skillFile].map((entry) =>
          expect.objectContaining({
            type: "issue",
            code: "verification-mode-mismatch",
            path: entry,
          }),
        ),
      ),
    );
    expect(fs.lstatSync(skillsDir)).toMatchObject({
      ino: dirBefore.ino,
      mode: dirBefore.mode,
    });
    expect(observeFixtureFile(skillFile)).toMatchObject({
      ino: fileBefore.ino,
      mode: fileBefore.mode,
      content: "state\n",
    });
  });

  it("reports nested skills and pairing drift without changing either entry (#9485)", () => {
    const { root, configDir } = fixture();
    const skillState = path.join(configDir, "skills", "pairing", "state.json");
    const pairingState = path.join(configDir, "pairing", "peers", "state.json");
    fs.mkdirSync(path.dirname(skillState), { recursive: true });
    fs.mkdirSync(path.dirname(pairingState), { recursive: true });
    fs.writeFileSync(skillState, "state\n", { mode: 0o660 });
    fs.writeFileSync(pairingState, "state\n", { mode: 0o660 });
    fs.chmodSync(path.join(configDir, "skills"), 0o2770);
    fs.chmodSync(path.join(configDir, "skills", "pairing"), 0o2770);
    fs.chmodSync(path.join(configDir, "pairing"), 0o2770);
    fs.chmodSync(path.join(configDir, "pairing", "peers"), 0o2770);
    fs.chmodSync(skillState, 0o400);
    fs.chmodSync(pairingState, 0o400);
    const skillBefore = fs.lstatSync(skillState);
    const pairingBefore = fs.lstatSync(pairingState);

    const observed = runGuard("verify-mutable", configDir, {
      NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
    });

    expect(observed.status).toBe(1);
    expect(observed.lines).toEqual(
      expect.arrayContaining(
        [skillState, pairingState].map((statePath) =>
          expect.objectContaining({
            type: "issue",
            code: "verification-mode-mismatch",
            path: statePath,
          }),
        ),
      ),
    );
    expect(observeFixtureFile(skillState)).toMatchObject({
      ino: skillBefore.ino,
      mode: skillBefore.mode,
      content: "state\n",
    });
    expect(observeFixtureFile(pairingState)).toMatchObject({
      ino: pairingBefore.ino,
      mode: pairingBefore.mode,
      content: "state\n",
    });
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });

  it("rejects an unsafe nested link without removing it (#9485)", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const outside = path.join(root, "outside.json");
    const unsafeLink = path.join(skillsDir, "outside.json");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(outside, "outside\n");
    fs.chmodSync(skillsDir, 0o2770);
    fs.symlinkSync(outside, unsafeLink);

    const observed = runGuard("verify-mutable", configDir);

    expect(observed.status).toBe(1);
    expect(observed.lines).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "symlink-outside-protected-root",
        path: unsafeLink,
      }),
    );
    expect(fs.readlinkSync(unsafeLink)).toBe(outside);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("reports recursive and Hermes boundary inode flags without clearing them (#9485)", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const profilesDir = path.join(configDir, "profiles");
    const dashboardDir = path.join(profilesDir, "dashboard-home");
    const nestedState = path.join(skillsDir, "state.json");
    const dashboardState = path.join(dashboardDir, "session.json");
    const configPath = path.join(configDir, "config.yaml");
    fs.mkdirSync(skillsDir);
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.writeFileSync(nestedState, "state\n", { mode: 0o660 });
    fs.writeFileSync(dashboardState, "dashboard\n", { mode: 0o600 });
    fs.writeFileSync(configPath, "config\n", { mode: 0o640 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(configDir, 0o3770);
    fs.chmodSync(skillsDir, 0o2770);
    fs.chmodSync(profilesDir, 0o2770);
    fs.chmodSync(dashboardDir, 0o700);
    const dashboardBefore = fs.lstatSync(dashboardDir);
    const immutableInodes = [
      fs.lstatSync(root).ino,
      fs.lstatSync(skillsDir).ino,
      fs.lstatSync(dashboardDir).ino,
    ].join(",");
    const appendOnlyInodes = [
      fs.lstatSync(configDir).ino,
      fs.lstatSync(dashboardDir).ino,
      fs.lstatSync(nestedState).ino,
      fs.lstatSync(configPath).ino,
    ].join(",");

    const observed = runGuard(
      "verify-mutable",
      configDir,
      {
        NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
        NEMOCLAW_TEST_IMMUTABLE_INODES: immutableInodes,
        NEMOCLAW_TEST_APPEND_ONLY_INODES: appendOnlyInodes,
      },
      [configPath],
    );

    expect(observed.status).toBe(1);
    expect(observed.lines).toEqual(
      expect.arrayContaining(
        [root, configDir, skillsDir, dashboardDir, nestedState, configPath].map((flaggedPath) =>
          expect.objectContaining({
            type: "issue",
            code: "verification-flags-mismatch",
            path: flaggedPath,
          }),
        ),
      ),
    );
    expect(observed.lines).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "verification-flags-mismatch",
        path: dashboardDir,
        detail: "immutable, append-only inode flag remains set",
      }),
    );
    expect(observed.lines).toContainEqual({
      type: "test-observation",
      inodeFlagMutationCalls: 0,
    });
    expect(fs.lstatSync(dashboardDir)).toMatchObject({
      ino: dashboardBefore.ino,
      mode: dashboardBefore.mode,
    });
    expect(fs.readFileSync(dashboardState, "utf8")).toBe("dashboard\n");
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });

  it("fails closed when a protected inode flag cannot be inspected (#9485)", () => {
    const { root, configDir } = fixture();
    const profilesDir = path.join(configDir, "profiles");
    const dashboardDir = path.join(profilesDir, "dashboard-home");
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.chmodSync(profilesDir, 0o2770);
    fs.chmodSync(dashboardDir, 0o700);
    const dashboardBefore = fs.lstatSync(dashboardDir);

    const observed = runGuard("verify-mutable", configDir, {
      NEMOCLAW_TEST_FLAGS_UNAVAILABLE_INODES: String(dashboardBefore.ino),
      NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
    });

    expect(observed.status).toBe(1);
    expect(observed.lines).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "verification-flags-unavailable",
        path: dashboardDir,
      }),
    );
    expect(fs.lstatSync(dashboardDir)).toMatchObject({
      ino: dashboardBefore.ino,
      mode: dashboardBefore.mode,
    });
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });

  it("rejects a non-directory Hermes writable root without changing it (#9485)", () => {
    const { root, configDir } = fixture();
    const profilesDir = path.join(configDir, "profiles");
    const dashboardPath = path.join(profilesDir, "dashboard-home");
    fs.mkdirSync(profilesDir);
    fs.writeFileSync(dashboardPath, "dashboard\n", { mode: 0o600 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(configDir, 0o3770);
    fs.chmodSync(profilesDir, 0o2770);
    const dashboardBefore = fs.lstatSync(dashboardPath);

    const observed = runGuard("verify-mutable", configDir, {
      NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
    });

    expect(observed.status).toBe(1);
    expect(observed.lines).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "verification-type-mismatch",
        path: dashboardPath,
        detail: "entry is a regular file, expected directory",
      }),
    );
    expect(observeFixtureFile(dashboardPath)).toMatchObject({
      ino: dashboardBefore.ino,
      mode: dashboardBefore.mode,
      content: "dashboard\n",
    });
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "darwin")(
    "allows an absent optional Hermes writable root during read-only observation (#9485)",
    () => {
      const { root, configDir } = fixture();
      const profilesDir = path.join(configDir, "profiles");
      fs.mkdirSync(profilesDir);
      fs.chmodSync(root, 0o755);
      fs.chmodSync(configDir, 0o3770);
      fs.chmodSync(profilesDir, 0o2770);

      const observed = runGuard("verify-mutable", configDir, {
        NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
      });

      expect(observed.status).toBe(0);
      expect(observed.lines.at(-1)).toEqual(
        expect.objectContaining({
          type: "result",
          action: "verify-mutable",
          status: "ok",
          issueCount: 0,
        }),
      );
      expect(observed.lines).toContainEqual({
        type: "test-observation",
        inodeFlagMutationCalls: 0,
      });
      expect(fs.existsSync(path.join(profilesDir, "dashboard-home"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
    },
  );

  it("rejects a live config-root replacement after recursive observation (#9485)", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const nestedState = path.join(skillsDir, "state.json");
    const configPath = path.join(configDir, "config.yaml");
    const oldConfigDir = path.join(root, ".hermes-observed");
    fs.mkdirSync(skillsDir);
    fs.chmodSync(root, 0o755);
    fs.chmodSync(configDir, 0o3770);
    fs.chmodSync(skillsDir, 0o2770);
    fs.writeFileSync(nestedState, "state\n", { mode: 0o660 });
    fs.writeFileSync(configPath, "config\n", { mode: 0o640 });

    const observed = runGuard(
      "verify-mutable",
      configDir,
      {
        NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
        NEMOCLAW_TEST_SWAP_CONFIG_PATH: configDir,
        NEMOCLAW_TEST_SWAP_OLD_PATH: oldConfigDir,
      },
      [configPath],
    );

    expect(observed.status).toBe(1);
    expect(observed.lines).toContainEqual(
      expect.objectContaining({
        type: "issue",
        code: "verification-config-binding-changed",
        path: configDir,
      }),
    );
    expect(fs.statSync(configDir).mode & 0o777).toBe(0o777);
    expect(fs.readFileSync(path.join(oldConfigDir, "config.yaml"), "utf8")).toBe("config\n");
    expect(fs.readFileSync(path.join(oldConfigDir, "skills", "state.json"), "utf8")).toBe(
      "state\n",
    );
    expect(fs.existsSync(path.join(root, ".openclaw-config-mutation.lock"))).toBe(false);
  });
});
