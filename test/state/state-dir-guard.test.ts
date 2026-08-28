// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "../helpers/timeouts";

const GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const fixtures: string[] = [];
const DEFAULT_PLAN = {
  version: 1,
  readOnlyRoots: ["agents", "cron", "extensions", "plugins", "skills"],
  confidentialRoots: ["credentials"],
  readOnlyPrefixes: ["workspace-"],
  confidentialPrefixes: [],
  writableSubpaths: ["agents/*/sessions"],
};
const PLAN_JSON = JSON.stringify(DEFAULT_PLAN);
const PYTHON_HAS_DESCRIPTOR_XATTR =
  spawnSync("python3", [
    "-c",
    "import os; assert all(hasattr(os, name) for name in ('listxattr', 'getxattr', 'setxattr'))",
  ]).status === 0;
// An unprivileged process can chgrp only to a group it belongs to, so a
// supplementary gid distinct from the primary gid stands in for the sandbox
// group; the ownership test skips on runners that have none.
const SUPPLEMENTARY_GID = Number(
  spawnSync(
    "python3",
    [
      "-c",
      "import os; groups = [g for g in os.getgroups() if g != os.getgid()]; print(groups[0] if groups else -1)",
    ],
    { encoding: "utf-8" },
  ).stdout.trim(),
);

const RUN_GUARD_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys

guard_path, action, config_dir, plan_flag, plan_value = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(),
    root_gid=os.getgid(),
    sandbox_uid=os.getuid(),
    sandbox_gid=os.getgid(),
)
module.os.geteuid = lambda: 0
module._production_identity = lambda: identity
if os.environ.get("NEMOCLAW_TEST_MAX_ENTRIES"):
    module.MAX_ENTRIES_PER_PASS = int(os.environ["NEMOCLAW_TEST_MAX_ENTRIES"])
if os.environ.get("NEMOCLAW_TEST_MAX_COPY_BYTES"):
    module.MAX_COPIED_BYTES_PER_PASS = int(os.environ["NEMOCLAW_TEST_MAX_COPY_BYTES"])
raise SystemExit(module.main([
    action, "--config-dir", config_dir, plan_flag, plan_value,
]))
`;

const RUN_BUNDLED_GUARD_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys

guard_path, action, config_dir = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("nemoclaw_bundled_state_dir_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
module.os.geteuid = lambda: 0
module._production_identity = lambda: identity
raise SystemExit(module.main([action, "--config-dir", config_dir]))
`;

const RUN_FAKE_IMMUTABLE_TRANSITION = String.raw`
import importlib.util
import json
import os
import struct
import sys

guard_path, config_dir, file_path, plan_json = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_flags", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
plan = module.parse_agent_state_lock_plan(plan_json)
flags = {}
initial = os.stat(file_path)
flags[(initial.st_dev, initial.st_ino)] = module.FS_IMMUTABLE_FL

def fake_ioctl(fd, operation, payload):
    st = os.fstat(fd)
    key = (st.st_dev, st.st_ino)
    if operation == module.FS_IOC_GETFLAGS:
        return struct.pack("I", flags.get(key, 0))
    if operation == module.FS_IOC_SETFLAGS:
        flags[key] = struct.unpack("I", payload)[0]
        return payload
    raise AssertionError(operation)

module.fcntl.ioctl = fake_ioctl
locked = module.run_guard("lock", config_dir, identity, plan)
locked_stat = os.stat(file_path)
locked_flags = flags.get((locked_stat.st_dev, locked_stat.st_ino), 0)
unlocked = module.run_guard("unlock", config_dir, identity, plan)
unlocked_stat = os.stat(file_path)
unlocked_flags = flags.get((unlocked_stat.st_dev, unlocked_stat.st_ino), 0)
print(json.dumps({
    "lock_ok": locked.ok,
    "unlock_ok": unlocked.ok,
    "inode_replaced": locked_stat.st_ino != initial.st_ino,
    "locked_flags": locked_flags,
    "unlocked_flags": unlocked_flags,
}))
`;

const RUN_SYMLINK_POST_CHOWN_RACE = String.raw`
import importlib.util
import json
import os
import sys

guard_path, config_dir, outside_dir = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_race", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
config_fd = module._open_absolute_dir_nofollow(config_dir)
plugins_fd = -1
original_chown = module.os.chown
try:
    config_st = os.fstat(config_fd)
    plugins_st = os.stat("plugins", dir_fd=config_fd, follow_symlinks=False)
    plugins_fd = module._open_child_dir(config_fd, "plugins", plugins_st)
    context = module.TraversalContext(
        config_fd, config_dir, config_st.st_dev, ("plugins",),
        module.WorkBudget(module.time.monotonic() + 30),
    )

    def racing_chown(name, uid, gid, *, dir_fd, follow_symlinks):
        original_chown(name, uid, gid, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
        os.unlink("target", dir_fd=dir_fd)
        os.symlink(outside_dir, "target", dir_fd=dir_fd)

    module.os.chown = racing_chown
    try:
        module._chown_symlink(
            plugins_fd, "current", "plugins/current", context,
            "high-risk", "unlock", identity,
        )
    except module.GuardOperationError as exc:
        print(json.dumps(exc.issue.as_json()))
    else:
        print(json.dumps({"type": "result", "status": "unexpected-success"}))
finally:
    module.os.chown = original_chown
    if plugins_fd >= 0:
        os.close(plugins_fd)
    os.close(config_fd)
`;

const RUN_GUARD_WITH_DISTINCT_SANDBOX_GID = String.raw`
import importlib.util
import json
import os
import sys

guard_path, config_dir, sandbox_gid, plan_json = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_gid", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=int(sandbox_gid),
)
plan = module.parse_agent_state_lock_plan(plan_json)
result = module.run_guard("lock", config_dir, identity, plan)


def group_of(path):
    return os.lstat(os.path.join(config_dir, path)).st_gid


print(json.dumps({
    "ok": result.ok,
    "rootGid": os.getgid(),
    "credentialsGid": group_of("credentials"),
    "nestedGid": group_of("credentials/providers"),
    "secretGid": group_of("credentials/providers/provider.json"),
}))
`;

const RUN_CARVEOUT_MKDIR_RACE = String.raw`
import importlib.util
import json
import os
import sys

guard_path, config_dir, plan_json = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_carveout", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(), root_gid=os.getgid(),
    sandbox_uid=os.getuid(), sandbox_gid=os.getgid(),
)
plan = module.parse_agent_state_lock_plan(plan_json)

def racing_mkdir(*args, **kwargs):
    raise FileExistsError(17, "File exists", "sessions")

module.os.mkdir = racing_mkdir
result = module.run_guard("lock", config_dir, identity, plan)
print(json.dumps({
    "ok": result.ok,
    "issues": [issue.as_json() for issue in result.issues],
}))
`;

const RUN_FAKE_MOUNT_BOUNDARY = String.raw`
import importlib.util
import json
import os
import sys
import time

guard_path, config_dir = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard_mount", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
config_fd = module._open_absolute_dir_nofollow(config_dir)
plugins_fd = -1
original_stat = module.os.stat
try:
    config_st = os.fstat(config_fd)
    plugins_st = original_stat("plugins", dir_fd=config_fd, follow_symlinks=False)
    plugins_fd = module._open_child_dir(config_fd, "plugins", plugins_st)
    mounted_st = original_stat("mounted", dir_fd=plugins_fd, follow_symlinks=False)
    context = module.TraversalContext(
        config_fd, config_dir, config_st.st_dev, ("plugins",),
        module.WorkBudget(time.monotonic() + 30),
    )

    def fake_stat(name, *args, **kwargs):
        if name == "outside.txt":
            raise AssertionError("cross-device mount contents were traversed")
        current = original_stat(name, *args, **kwargs)
        if name == "mounted" and kwargs.get("dir_fd") == plugins_fd:
            fields = list(mounted_st)
            fields[2] = config_st.st_dev + 1
            return os.stat_result(fields)
        return current

    module.os.stat = fake_stat
    issues = []
    module._scan_dir(context, plugins_fd, "plugins", issues, 0, "preflight")
    print(json.dumps([issue.as_json() for issue in issues]))
finally:
    module.os.stat = original_stat
    if plugins_fd >= 0:
        os.close(plugins_fd)
    os.close(config_fd)
`;

interface GuardLine {
  type: "issue" | "result";
  code?: string;
  path?: string;
  detail?: string;
  action?: string;
  status?: string;
  issueCount?: number;
  removedEntries?: number;
}

function fixture(configDirName = ".agent"): { root: string; configDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-dir-guard-"));
  fixtures.push(root);
  const configDir = path.join(root, configDirName);
  fs.mkdirSync(configDir, { recursive: true });
  // macOS exposes /var through a symlink. The production helper refuses
  // symlinked ancestors, so pass the descriptor-resolved fixture path too.
  return { root, configDir: fs.realpathSync(configDir) };
}

function runGuardWithPlanSource(
  action: "preflight" | "lock" | "unlock" | "startup",
  configDir: string,
  planFlag: "--plan-json" | "--plan-file",
  planValue: string,
  env: Record<string, string> = {},
) {
  const result = spawnSync(
    "python3",
    ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, action, configDir, planFlag, planValue],
    { encoding: "utf-8", timeout: 15_000, env: { ...process.env, ...env } },
  );
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuardLine);
  return { ...result, lines };
}

function runGuard(
  action: "preflight" | "lock" | "unlock" | "startup",
  configDir: string,
  env: Record<string, string> = {},
  plan: unknown = DEFAULT_PLAN,
) {
  return runGuardWithPlanSource(action, configDir, "--plan-json", JSON.stringify(plan), env);
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o7777;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.chmodSync(root, 0o700);
    const configDir = path.join(root, ".agent");
    for (const existingConfigDir of fs.existsSync(configDir) ? [configDir] : []) {
      fs.chmodSync(existingConfigDir, 0o700);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("state-dir-guard", () => {
  it("requires an explicit plan outside the bundled helper layout and rejects multiple sources", () => {
    const { root, configDir } = fixture();
    const planFile = path.join(root, "plan.json");
    fs.writeFileSync(planFile, PLAN_JSON);

    const missing = spawnSync("python3", [GUARD_PATH, "preflight", "--config-dir", configDir], {
      encoding: "utf-8",
    });
    const repeated = spawnSync(
      "python3",
      [
        GUARD_PATH,
        "preflight",
        "--config-dir",
        configDir,
        "--plan-json",
        PLAN_JSON,
        "--plan-file",
        planFile,
      ],
      { encoding: "utf-8" },
    );

    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("");
    expect(missing.stdout).toContain('"code":"invalid-plan"');
    expect(repeated.status).toBe(2);
    expect(repeated.stderr).toContain("not allowed with argument");
  });

  it("supports the previous CLI wire form only from a co-bundled generated plan", () => {
    const { root, configDir } = fixture();
    const helperPath = path.join(root, "image", "lib", "nemoclaw", "state-dir-guard.py");
    const planPath = path.join(root, "image", "share", "nemoclaw", "state-lock-plan.json");
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.mkdirSync(pluginsDir);
    fs.copyFileSync(GUARD_PATH, helperPath);
    fs.writeFileSync(planPath, PLAN_JSON);
    fs.chmodSync(pluginsDir, 0o2770);

    const result = spawnSync(
      "python3",
      ["-c", RUN_BUNDLED_GUARD_AS_CURRENT_USER, helperPath, "lock", configDir],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(mode(pluginsDir)).toBe(0o755);
  });

  it("loads an SPDX-annotated plan file", () => {
    const { root, configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    const planFile = path.join(root, "state-lock-plan.json");
    fs.mkdirSync(pluginsDir);
    fs.writeFileSync(
      planFile,
      JSON.stringify({
        $comment:
          "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. SPDX-License-Identifier: Apache-2.0",
        ...DEFAULT_PLAN,
      }),
    );

    const result = runGuardWithPlanSource("preflight", configDir, "--plan-file", planFile);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines.at(-1)).toEqual(
      expect.objectContaining({ type: "result", status: "ok", roots: 1 }),
    );
  });

  it.each(
    Array.from(
      [
        ["missing.json", () => undefined],
        ["non-utf8.json", (planFile) => fs.writeFileSync(planFile, Buffer.from([0xff]))],
        [
          "oversized.json",
          (planFile) => fs.writeFileSync(planFile, Buffer.alloc(1024 * 1024 + 1, 0x20)),
        ],
      ] as Array<[string, (planFile: string) => void]>,
      (value) => [value],
    ),
  )("rejects missing, non-UTF-8, and oversized plan files [case %#]", ([fileName, writePlan]) => {
    const { root, configDir } = fixture();

    const planFile = path.join(root, fileName);
    writePlan(planFile);

    const result = runGuardWithPlanSource("preflight", configDir, "--plan-file", planFile);

    expect(result.status, fileName).toBe(1);
    expect(result.lines, fileName).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "invalid-plan" }),
        expect.objectContaining({ type: "result", status: "failed", issueCount: 1 }),
      ]),
    );
  });
  it.each([
    ["malformed JSON", "{"],
    ["duplicate JSON keys", PLAN_JSON.replace('"version":1', '"version":1,"version":1')],
    ["missing keys", "{}"],
    ["unknown keys", JSON.stringify({ ...DEFAULT_PLAN, registry: [] })],
    ["non-string comment", JSON.stringify({ ...DEFAULT_PLAN, $comment: 1 })],
    ["null comment", JSON.stringify({ ...DEFAULT_PLAN, $comment: null })],
    ["wrong version", JSON.stringify({ ...DEFAULT_PLAN, version: true })],
    ["unsafe top-level root", JSON.stringify({ ...DEFAULT_PLAN, readOnlyRoots: ["../plugins"] })],
    [
      "unsafe top-level prefix",
      JSON.stringify({ ...DEFAULT_PLAN, readOnlyPrefixes: ["workspace/"] }),
    ],
    ["duplicate root", JSON.stringify({ ...DEFAULT_PLAN, readOnlyRoots: ["plugins", "plugins"] })],
    [
      "conflicting root policy",
      JSON.stringify({
        ...DEFAULT_PLAN,
        confidentialRoots: ["plugins"],
      }),
    ],
    [
      "overlapping prefixes",
      JSON.stringify({
        ...DEFAULT_PLAN,
        readOnlyPrefixes: ["workspace-", "workspace-dev-"],
      }),
    ],
    [
      "partial-component wildcard",
      JSON.stringify({ ...DEFAULT_PLAN, writableSubpaths: ["agents/a*/sessions"] }),
    ],
    ["final wildcard", JSON.stringify({ ...DEFAULT_PLAN, writableSubpaths: ["agents/*"] })],
    [
      "overlapping writable subpaths",
      JSON.stringify({
        ...DEFAULT_PLAN,
        writableSubpaths: ["agents/*/sessions", "agents/main/sessions"],
      }),
    ],
    [
      "writable path under a confidential root",
      JSON.stringify({
        ...DEFAULT_PLAN,
        writableSubpaths: ["credentials/runtime"],
      }),
    ],
  ])("rejects a plan with %s", (_case, planJson) => {
    const { configDir } = fixture();

    const result = runGuardWithPlanSource("preflight", configDir, "--plan-json", planJson);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "invalid-plan" }),
        expect.objectContaining({ type: "result", status: "failed", issueCount: 1 }),
      ]),
    );
  });

  it("selects exact roots and prefixes only from the supplied plan", () => {
    const { configDir } = fixture();
    const selectedRoot = path.join(configDir, "custom");
    const selectedPrefix = path.join(configDir, "project-blue");
    const unselectedRoot = path.join(configDir, "plugins");
    fs.mkdirSync(selectedRoot);
    fs.mkdirSync(selectedPrefix);
    fs.mkdirSync(unselectedRoot);
    fs.chmodSync(selectedRoot, 0o2770);
    fs.chmodSync(selectedPrefix, 0o2770);
    fs.chmodSync(unselectedRoot, 0o2770);
    const plan = {
      version: 1,
      readOnlyRoots: ["custom"],
      confidentialRoots: [],
      readOnlyPrefixes: ["project-"],
      confidentialPrefixes: [],
      writableSubpaths: [],
    };

    const result = runGuard("lock", configDir, {}, plan);

    expect(result.status, result.stderr).toBe(0);
    expect(mode(selectedRoot)).toBe(0o755);
    expect(mode(selectedPrefix)).toBe(0o755);
    expect(mode(unselectedRoot)).toBe(0o2770);
  });

  it("creates and preserves a generic wildcard writable subpath", () => {
    const { configDir } = fixture();
    const workerDir = path.join(configDir, "workers", "main");
    const runsDir = path.join(workerDir, "runs");
    fs.mkdirSync(workerDir, { recursive: true });
    const plan = {
      version: 1,
      readOnlyRoots: ["workers"],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: ["workers/*/runs"],
    };

    const locked = runGuard("lock", configDir, {}, plan);
    fs.writeFileSync(path.join(runsDir, "live.log"), "runtime\n", { mode: 0o660 });
    const relocked = runGuard("lock", configDir, {}, plan);

    expect(locked.status, locked.stderr).toBe(0);
    expect(relocked.status, relocked.stderr).toBe(0);
    expect(mode(runsDir)).toBe(0o2770);
    expect(fs.readFileSync(path.join(runsDir, "live.log"), "utf-8")).toBe("runtime\n");
  });

  it("rejects a config root reached through a symlinked ancestor", () => {
    const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-dir-guard-"));
    fixtures.push(rawRoot);
    const root = fs.realpathSync(rawRoot);
    const realParent = path.join(root, "real-parent");
    const linkedParent = path.join(root, "linked-parent");
    const realConfigDir = path.join(realParent, ".agent");
    fs.mkdirSync(realConfigDir, { recursive: true });
    fs.symlinkSync(realParent, linkedParent);
    const configDir = path.join(linkedParent, ".agent");

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "config-open-failed",
          path: configDir,
        }),
        expect.objectContaining({
          type: "result",
          action: "preflight",
          status: "failed",
          issueCount: 1,
        }),
      ]),
    );
  });

  it("rejects an external nested symlink without touching its target", () => {
    const { root, configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins", "nested");
    const externalDir = path.join(root, "outside");
    const externalFile = path.join(externalDir, "innocent.txt");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(externalDir);
    fs.writeFileSync(externalFile, "untouched\n", { mode: 0o666 });
    const externalMode = mode(externalFile);
    fs.symlinkSync(externalDir, path.join(pluginDir, "escape"));

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-outside-protected-root",
          path: path.join(pluginDir, "escape"),
        }),
        expect.objectContaining({
          type: "result",
          action: "preflight",
          status: "failed",
          issueCount: 1,
        }),
      ]),
    );
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("untouched\n");
    expect(mode(externalFile)).toBe(externalMode);
  });

  it("allows a symlink whose fully resolved target stays in a protected root", () => {
    const { configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const versionDir = path.join(pluginDir, "versions", "v1");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "plugin.js"), "export {};\n", { mode: 0o664 });
    fs.symlinkSync("versions/v1", path.join(pluginDir, "current"));

    const preflight = runGuard("preflight", configDir);
    const locked = runGuard("lock", configDir);

    expect(preflight.status).toBe(0);
    expect(locked.status).toBe(0);
    expect(fs.readlinkSync(path.join(pluginDir, "current"))).toBe("versions/v1");
    expect(mode(pluginDir)).toBe(0o755);
    expect(mode(path.join(versionDir, "plugin.js"))).toBe(0o644);
  });

  it("keeps the runtime ledger writable while sealing cron job definitions", () => {
    const { configDir } = fixture(".hermes");
    const cronDir = path.join(configDir, "cron");
    const cronLedger = path.join(cronDir, "executions.db");
    const runtimeDir = path.join(configDir, "runtime");
    const runtimeLedger = path.join(runtimeDir, "cron-executions.db");
    fs.mkdirSync(cronDir);
    fs.mkdirSync(runtimeDir);
    fs.chmodSync(cronDir, 0o2770);
    fs.chmodSync(runtimeDir, 0o2770);
    fs.writeFileSync(cronLedger, "legacy ledger\n", { mode: 0o660 });
    fs.writeFileSync(runtimeLedger, "active ledger\n", { mode: 0o660 });
    fs.chmodSync(runtimeLedger, 0o660);

    const locked = runGuard("lock", configDir);

    expect(locked.status, locked.stderr).toBe(0);
    expect(mode(cronDir)).toBe(0o755);
    expect(mode(cronLedger)).toBe(0o640);
    expect(mode(runtimeDir)).toBe(0o2770);
    expect(mode(runtimeLedger)).toBe(0o660);
    fs.appendFileSync(runtimeLedger, "still writable\n");
    expect(fs.readFileSync(runtimeLedger, "utf8")).toContain("still writable");
  });

  it("keeps owner-private high-risk state readable after transferring ownership (#8304)", () => {
    const { configDir } = fixture();
    const devicesDir = path.join(configDir, "devices");
    const journalPath = path.join(devicesDir, "pending.json.nemoclaw-self-approval-journal");
    const helperPath = path.join(devicesDir, "refresh-device-state");
    fs.mkdirSync(devicesDir);
    fs.writeFileSync(journalPath, "{}\n", { mode: 0o600 });
    fs.writeFileSync(helperPath, "#!/bin/sh\n", { mode: 0o700 });
    fs.chmodSync(journalPath, 0o600);
    fs.chmodSync(helperPath, 0o700);
    const oldJournalInode = fs.statSync(journalPath).ino;
    const oldHelperInode = fs.statSync(helperPath).ino;
    const plan = {
      version: 1,
      readOnlyRoots: ["devices"],
      confidentialRoots: [],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    };
    const locked = runGuard("lock", configDir, {}, plan);
    expect(locked.status, `${locked.stderr}\n${locked.stdout}`).toBe(0);
    expect(fs.statSync(journalPath).ino).not.toBe(oldJournalInode);
    expect(fs.statSync(helperPath).ino).not.toBe(oldHelperInode);
    expect(mode(journalPath)).toBe(0o640);
    expect(mode(helperPath)).toBe(0o750);
    expect(mode(journalPath) & 0o022).toBe(0);
    expect(mode(helperPath) & 0o022).toBe(0);
  });

  it("rejects a nested symlink target replaced during unlock ownership change", () => {
    const { root, configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    const currentLink = path.join(pluginsDir, "current");
    const targetLink = path.join(pluginsDir, "target");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(path.join(pluginsDir, "versions", "v1"), { recursive: true });
    fs.mkdirSync(outsideDir);
    fs.symlinkSync("versions/v1", targetLink);
    fs.symlinkSync("target", currentLink);

    const result = spawnSync(
      "python3",
      ["-c", RUN_SYMLINK_POST_CHOWN_RACE, GUARD_PATH, configDir, outsideDir],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(
      expect.objectContaining({
        type: "issue",
        code: "symlink-outside-protected-root",
        path: currentLink,
      }),
    );
    expect(fs.readlinkSync(targetLink)).toBe(outsideDir);
  });

  it("rejects a descriptor-observed cross-device mount without traversing its contents", () => {
    const { configDir } = fixture();
    const mountedDir = path.join(configDir, "plugins", "mounted");
    const outsideFile = path.join(mountedDir, "outside.txt");
    fs.mkdirSync(mountedDir, { recursive: true });
    fs.writeFileSync(outsideFile, "untouched\n");

    const result = spawnSync("python3", ["-c", RUN_FAKE_MOUNT_BOUNDARY, GUARD_PATH, configDir], {
      encoding: "utf-8",
      timeout: 15_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      expect.objectContaining({
        type: "issue",
        code: "cross-device-entry",
        path: mountedDir,
      }),
    ]);
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("untouched\n");
  });
  it.each([
    ["slack", "/usr/local/lib/node_modules/openclaw"],
    ["whatsapp", "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw"],
  ])("preserves the exact image-owned OpenClaw %s peer link across transitions", (extensionId, target) => {
      const { configDir } = fixture(".openclaw");
      const peerLink = path.join(configDir, "extensions", extensionId, "node_modules", "openclaw");
      fs.mkdirSync(path.dirname(peerLink), { recursive: true });
      fs.symlinkSync(target, peerLink);

      const preflight = runGuard("preflight", configDir);
      const locked = runGuard("lock", configDir);
      const unlocked = runGuard("unlock", configDir);

      expect(preflight.status, preflight.stderr).toBe(0);
      expect(locked.status, locked.stderr).toBe(0);
      expect(unlocked.status, unlocked.stderr).toBe(0);
      expect(fs.lstatSync(peerLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(peerLink)).toBe(target);
      expect(locked.lines.at(-1)).toEqual(
        expect.objectContaining({
          type: "result",
          action: "lock",
          status: "ok",
          removedEntries: 0,
        }),
      );
  });

  it.each([
    ["tampered target", "slack", "node_modules/openclaw", "/usr/local/lib/node_modules/other"],
    [
      "tampered locked runtime target",
      "whatsapp",
      "node_modules/openclaw",
      "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/other",
    ],
    [
      "traversal-shaped extension id",
      "%2e%2e",
      "node_modules/openclaw",
      "/usr/local/lib/node_modules/openclaw",
    ],
    ["wrong source path", "slack", "openclaw", "/usr/local/lib/node_modules/openclaw"],
  ])("rejects a managed extension peer link with a %s", (_case, extensionId, suffix, target) => {
    const { configDir } = fixture(".openclaw");
    const peerLink = path.join(configDir, "extensions", extensionId, suffix);
    fs.mkdirSync(path.dirname(peerLink), { recursive: true });
    fs.symlinkSync(target, peerLink);

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-outside-protected-root",
          path: peerLink,
        }),
      ]),
    );
  });

  it("does not trust an OpenClaw peer target under a non-OpenClaw state root", () => {
    const { configDir } = fixture(".hermes");
    const peerLink = path.join(configDir, "extensions", "slack", "node_modules", "openclaw");
    fs.mkdirSync(path.dirname(peerLink), { recursive: true });
    fs.symlinkSync("/usr/local/lib/node_modules/openclaw", peerLink);

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-outside-protected-root",
          path: peerLink,
        }),
      ]),
    );
  });

  it("rejects links from protected code into the writable sessions carveout", () => {
    const { configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const pluginPath = path.join(pluginDir, "trusted.js");
    const sessionsDir = path.join(configDir, "agents", "main", "sessions");
    const sessionPayload = path.join(sessionsDir, "payload.js");
    fs.mkdirSync(pluginDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(pluginPath, "trusted\n");
    fs.writeFileSync(sessionPayload, "mutable\n");
    fs.symlinkSync("../agents/main/sessions/payload.js", path.join(pluginDir, "evil"));

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          code: "symlink-crosses-runtime-carveout",
          path: path.join(pluginDir, "evil"),
        }),
      ]),
    );
  });

  it("fresh-replaces locked files so an old writable FD cannot mutate the visible path", () => {
    const { configDir } = fixture();
    const nestedDir = path.join(configDir, "extensions", "nested");
    const toolPath = path.join(nestedDir, "tool.sh");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(toolPath, "stable\n", { mode: 0o775 });
    const preservedTime = new Date("2025-01-02T03:04:05.000Z");
    fs.utimesSync(toolPath, preservedTime, preservedTime);
    const timestampsBefore = fs.statSync(toolPath);
    const oldInode = fs.statSync(toolPath).ino;
    const staleFd = fs.openSync(toolPath, "r+");

    try {
      const result = runGuard("lock", configDir);
      expect(result.status).toBe(0);
      expect(result.lines.at(-1)).toEqual(
        expect.objectContaining({ type: "result", action: "lock", status: "ok" }),
      );
      expect(fs.statSync(toolPath).ino).not.toBe(oldInode);
      expect(mode(nestedDir)).toBe(0o755);
      expect(mode(toolPath)).toBe(0o755);
      const timestampsAfter = fs.statSync(toolPath);
      // The guard publishes the requested atime, but its verification read can
      // advance atime on relatime filesystems after ctime changes.
      expect(timestampsAfter.mtimeMs).toBe(timestampsBefore.mtimeMs);

      fs.writeSync(staleFd, Buffer.from("MUTATE\n"), 0, 7, 0);
      fs.fsyncSync(staleFd);
      expect(fs.readFileSync(toolPath, "utf-8")).toBe("stable\n");
    } finally {
      fs.closeSync(staleFd);
    }
  });

  it.skipIf(!PYTHON_HAS_DESCRIPTOR_XATTR)(
    "preserves an extended attribute through fresh-inode lock and unlock",
    () => {
      const { configDir } = fixture();
      const pluginDir = path.join(configDir, "plugins");
      const pluginPath = path.join(pluginDir, "metadata.js");
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(pluginPath, "export {};\n", { mode: 0o660 });
      const setAttribute = spawnSync(
        "python3",
        [
          "-c",
          'import os, sys; os.setxattr(sys.argv[1], "user.nemoclaw.test", b"preserved")',
          pluginPath,
        ],
        { encoding: "utf-8" },
      );
      expect(setAttribute.status, setAttribute.stderr).toBe(0);
      const originalInode = fs.statSync(pluginPath).ino;

      const locked = runGuard("lock", configDir);
      const lockedInode = fs.statSync(pluginPath).ino;
      const readLockedAttribute = spawnSync(
        "python3",
        [
          "-c",
          'import os, sys; print(os.getxattr(sys.argv[1], "user.nemoclaw.test").decode())',
          pluginPath,
        ],
        { encoding: "utf-8" },
      );
      const unlocked = runGuard("unlock", configDir);
      const readUnlockedAttribute = spawnSync(
        "python3",
        [
          "-c",
          'import os, sys; print(os.getxattr(sys.argv[1], "user.nemoclaw.test").decode())',
          pluginPath,
        ],
        { encoding: "utf-8" },
      );

      expect(locked.status, locked.stderr).toBe(0);
      expect(lockedInode).not.toBe(originalInode);
      expect(readLockedAttribute.status, readLockedAttribute.stderr).toBe(0);
      expect(readLockedAttribute.stdout.trim()).toBe("preserved");
      expect(unlocked.status, unlocked.stderr).toBe(0);
      expect(readUnlockedAttribute.status, readUnlockedAttribute.stderr).toBe(0);
      expect(readUnlockedAttribute.stdout.trim()).toBe("preserved");
    },
  );

  it(
    "fresh-seals a file even while an attacker continuously writes an old descriptor",
    testTimeoutOptions(20_000),
    async () => {
      const { root, configDir } = fixture();
      const pluginDir = path.join(configDir, "plugins");
      const pluginPath = path.join(pluginDir, "racing.bin");
      const readyPath = path.join(root, "writer-ready");
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(pluginPath, Buffer.alloc(8 * 1024 * 1024, 0x41), { mode: 0o660 });
      const oldInode = fs.statSync(pluginPath).ino;
      const writer = spawn(
        process.execPath,
        [
          "-e",
          [
            "const fs=require('fs')",
            "const file=process.argv[1]",
            "const ready=process.argv[2]",
            "const fd=fs.openSync(file,'r+')",
            "const chunk=Buffer.alloc(1024*1024,0x5a)",
            "fs.writeFileSync(ready,'ready')",
            "setInterval(()=>{try{fs.writeSync(fd,chunk,0,chunk.length,0)}catch{}},0)",
          ].join(";"),
          pluginPath,
          readyPath,
        ],
        { stdio: "ignore" },
      );

      try {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(readyPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fs.existsSync(readyPath)).toBe(true);

        const result = runGuard("lock", configDir);

        expect(result.status, result.stderr).toBe(0);
        expect(fs.statSync(pluginPath).ino).not.toBe(oldInode);
        expect(mode(pluginPath)).toBe(0o640);
      } finally {
        writer.kill("SIGKILL");
      }
    },
  );

  it(
    "streams a large file into a fresh inode while preserving read and execute bits",
    testTimeoutOptions(20_000),
    () => {
      const { configDir } = fixture();
      const workspaceDir = path.join(configDir, "workspace-large");
      const payloadPath = path.join(workspaceDir, "model.bin");
      const payload = Buffer.alloc(1024 * 1024, 0xa5);
      fs.mkdirSync(workspaceDir);
      fs.writeFileSync(payloadPath, payload, { mode: 0o751 });
      const oldInode = fs.statSync(payloadPath).ino;

      const result = runGuard("lock", configDir);

      expect(result.status).toBe(0);
      expect(fs.statSync(payloadPath).ino).not.toBe(oldInode);
      expect(mode(payloadPath)).toBe(0o751);
      expect(fs.readFileSync(payloadPath)).toEqual(payload);
    },
  );

  it("preserves sparse holes instead of expanding logical size into copied bytes", () => {
    const { configDir } = fixture();
    const workspaceDir = path.join(configDir, "workspace-sparse");
    const payloadPath = path.join(workspaceDir, "sparse.bin");
    fs.mkdirSync(workspaceDir);
    const fd = fs.openSync(payloadPath, "w", 0o660);
    try {
      fs.writeSync(fd, Buffer.from("head"), 0, 4, 0);
      fs.writeSync(fd, Buffer.from("tail"), 0, 4, 64 * 1024 * 1024 - 4);
    } finally {
      fs.closeSync(fd);
    }
    const before = fs.statSync(payloadPath);

    const result = runGuard("lock", configDir, {
      NEMOCLAW_TEST_MAX_COPY_BYTES: String(1024 * 1024),
    });

    expect(result.status).toBe(0);
    const after = fs.statSync(payloadPath);
    expect(after.size).toBe(before.size);
    const verifyFd = fs.openSync(payloadPath, "r");
    try {
      const head = Buffer.alloc(4);
      const tail = Buffer.alloc(4);
      fs.readSync(verifyFd, head, 0, 4, 0);
      fs.readSync(verifyFd, tail, 0, 4, after.size - 4);
      expect(head.toString()).toBe("head");
      expect(tail.toString()).toBe("tail");
    } finally {
      fs.closeSync(verifyFd);
    }
    // st_blocks is 512-byte units. Allow filesystem metadata variance while
    // proving the 64 MiB logical hole was not materialized.
    expect(after.blocks * 512).toBeLessThan(1024 * 1024);
  });

  it("rejects adversarial entry and copy budgets before unbounded work", () => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir);
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(pluginsDir, `entry-${index}.txt`), "payload\n");
    }

    const result = runGuard("preflight", configDir, {
      NEMOCLAW_TEST_MAX_ENTRIES: "3",
    });

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
      ]),
    );
  });

  it.each([
    ["OpenClaw", "NEMOCLAW_TEST_OPENCLAW_FAIL_CLOSED"],
    ["Hermes", "NEMOCLAW_TEST_HERMES_FAIL_CLOSED"],
    ["Deep Agents", "NEMOCLAW_TEST_DEEP_AGENTS_FAIL_CLOSED"],
  ])("leaves the %s config root fail-closed when a state-tree budget aborts lock", (_agent, env) => {
      const { configDir } = fixture();
      const pluginsDir = path.join(configDir, "plugins");
      const pluginPath = path.join(pluginsDir, "entry-0.txt");
      fs.mkdirSync(pluginsDir);
      for (let index = 0; index < 5; index += 1) {
        fs.writeFileSync(path.join(pluginsDir, `entry-${index}.txt`), "payload\n");
      }
      const staleFd = fs.openSync(pluginPath, "r+");

      try {
        const result = runGuard("lock", configDir, {
          NEMOCLAW_TEST_MAX_ENTRIES: "3",
          [env]: "1",
        });

        expect(result.status).toBe(1);
        expect(result.lines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
          ]),
        );
        expect(mode(configDir)).toBe(0o500);
        fs.writeSync(staleFd, Buffer.from("stale\n"), 0, 6, 0);
        expect(mode(configDir)).not.toBe(0o755);
      } finally {
        fs.closeSync(staleFd);
      }
  });

  it.each([
    ["OpenClaw", "NEMOCLAW_TEST_OPENCLAW_FAIL_CLOSED"],
    ["Hermes", "NEMOCLAW_TEST_HERMES_FAIL_CLOSED"],
    ["Deep Agents", "NEMOCLAW_TEST_DEEP_AGENTS_FAIL_CLOSED"],
  ])("restores traversal of the %s config root only after a successful lock", (_agent, env) => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    fs.mkdirSync(pluginsDir);
    fs.writeFileSync(path.join(pluginsDir, "plugin.js"), "module.exports = true;\n");

    const result = runGuard("lock", configDir, { [env]: "1" });

    expect(result.status).toBe(0);
    expect(result.lines).toContainEqual(
      expect.objectContaining({ type: "result", action: "lock", status: "ok" }),
    );
    expect(mode(configDir)).toBe(0o755);
  });

  it("serializes an orphaned recursive unlock ahead of the restoring lock", async () => {
    const { root, configDir } = fixture();
    const pluginDir = path.join(configDir, "plugins");
    const pluginFile = path.join(pluginDir, "plugin.js");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(pluginFile, "module.exports = true;\n", { mode: 0o660 });
    const ready = path.join(root, "unlock-holds-mutex");
    const commonEnv = {
      ...process.env,
      NEMOCLAW_TEST_OPENCLAW_TRANSACTION_LOCK: "1",
    };
    const unlock = spawn(
      "python3",
      ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, "unlock", configDir, "--plan-json", PLAN_JSON],
      {
        env: {
          ...commonEnv,
          NEMOCLAW_TEST_TRANSACTION_LOCK_HOLD_MS: "700",
          NEMOCLAW_TEST_TRANSACTION_LOCK_READY: ready,
        },
        stdio: "ignore",
      },
    );

    try {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(ready)).toBe(true);

      const startedAt = Date.now();
      const locked = spawnSync(
        "python3",
        ["-c", RUN_GUARD_AS_CURRENT_USER, GUARD_PATH, "lock", configDir, "--plan-json", PLAN_JSON],
        { env: commonEnv, encoding: "utf-8", timeout: 10_000 },
      );

      expect(locked.status, locked.stderr).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(mode(pluginFile)).toBe(0o640);
    } finally {
      unlock.kill("SIGKILL");
    }
  });

  it("charges empty workspace roots against the same bounded inventory", () => {
    const { configDir } = fixture();
    for (let index = 0; index < 5; index += 1) {
      fs.mkdirSync(path.join(configDir, `workspace-${index}`));
    }

    const result = runGuard("preflight", configDir, {
      NEMOCLAW_TEST_MAX_ENTRIES: "3",
    });

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "work-entry-limit" }),
      ]),
    );
  });

  it("descriptor-clears legacy immutable flags and reapplies them only to the locked inode", () => {
    const { configDir } = fixture();
    const pluginsDir = path.join(configDir, "plugins");
    const pluginPath = path.join(pluginsDir, "legacy-immutable.js");
    fs.mkdirSync(pluginsDir);
    fs.writeFileSync(pluginPath, "export {};\n", { mode: 0o660 });

    const result = spawnSync(
      "python3",
      ["-c", RUN_FAKE_IMMUTABLE_TRANSITION, GUARD_PATH, configDir, pluginPath, PLAN_JSON],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      lock_ok: true,
      unlock_ok: true,
      inode_replaced: true,
      locked_flags: 0x10,
      unlocked_flags: 0,
    });
  });

  it("applies distinct confidentiality, workspace, and writable runtime modes", () => {
    const { configDir } = fixture();
    const secretDir = path.join(configDir, "credentials");
    const secretPath = path.join(secretDir, "token.json");
    const nestedSecretDir = path.join(secretDir, "providers");
    const nestedSecretPath = path.join(nestedSecretDir, "provider.json");
    const workspaceDir = path.join(configDir, "workspace-research");
    const executablePath = path.join(workspaceDir, "run.sh");
    const agentDir = path.join(configDir, "agents", "main");
    const sessionsDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionsDir, "active.jsonl");
    const sessionBacklink = path.join(sessionsDir, "runtime-link");
    const sessionFifo = path.join(sessionsDir, "runtime-events.fifo");
    const agentCodePath = path.join(agentDir, "agent.js");
    fs.mkdirSync(nestedSecretDir, { recursive: true });
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(secretPath, "secret\n", { mode: 0o640 });
    fs.writeFileSync(nestedSecretPath, "secret\n", { mode: 0o640 });
    fs.writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o775 });
    fs.writeFileSync(sessionPath, "runtime\n", { mode: 0o660 });
    fs.writeFileSync(agentCodePath, "export {};\n", { mode: 0o664 });
    fs.symlinkSync("../../../plugins/runtime-only", sessionBacklink);
    expect(spawnSync("mkfifo", [sessionFifo]).status).toBe(0);
    const initialSessionMode = mode(sessionPath);
    const oldSessionInode = fs.statSync(sessionPath).ino;
    const oldAgentCodeInode = fs.statSync(agentCodePath).ino;

    const locked = runGuard("lock", configDir);

    expect(locked.status).toBe(0);
    expect(mode(secretDir)).toBe(0o710);
    expect(mode(nestedSecretDir)).toBe(0o700);
    expect(mode(secretPath)).toBe(0o600);
    expect(mode(nestedSecretPath)).toBe(0o600);
    expect(mode(workspaceDir)).toBe(0o755);
    expect(mode(executablePath)).toBe(0o755);
    expect(mode(path.join(configDir, "agents"))).toBe(0o755);
    expect(mode(agentDir)).toBe(0o755);
    expect(fs.statSync(agentCodePath).ino).not.toBe(oldAgentCodeInode);
    expect(mode(sessionsDir)).toBe(0o2770);
    expect(mode(sessionPath)).toBe(initialSessionMode);
    expect(fs.statSync(sessionPath).ino).toBe(oldSessionInode);
    expect(fs.readlinkSync(sessionBacklink)).toBe("../../../plugins/runtime-only");
    expect(fs.lstatSync(sessionFifo).isFIFO()).toBe(true);

    const unlocked = runGuard("unlock", configDir);

    expect(unlocked.status).toBe(0);
    expect(mode(secretDir)).toBe(0o2770);
    expect(mode(secretPath)).toBe(0o660);
    expect(mode(workspaceDir)).toBe(0o2770);
    expect(mode(executablePath)).toBe(0o770);
    expect(mode(path.join(configDir, "agents"))).toBe(0o2770);
    expect(mode(agentDir)).toBe(0o2770);
  });

  it.skipIf(SUPPLEMENTARY_GID < 0)(
    "assigns the sandbox group to the confidentiality root only, while nested entries keep the root group (#7545)",
    () => {
      const { configDir } = fixture(".openclaw");
      const nested = path.join(configDir, "credentials", "providers");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "provider.json"), "secret\n", { mode: 0o640 });

      const result = spawnSync(
        "python3",
        [
          "-c",
          RUN_GUARD_WITH_DISTINCT_SANDBOX_GID,
          GUARD_PATH,
          configDir,
          String(SUPPLEMENTARY_GID),
          PLAN_JSON,
        ],
        { encoding: "utf-8", timeout: 15_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.rootGid).not.toBe(SUPPLEMENTARY_GID);
      expect(parsed.credentialsGid).toBe(SUPPLEMENTARY_GID);
      expect(parsed.nestedGid).toBe(parsed.rootGid);
      expect(parsed.secretGid).toBe(parsed.rootGid);
    },
  );

  it("restores startup traversal for sealed credentials roots without exposing contents (#8112)", () => {
    const { configDir } = fixture();
    const credentialsDir = path.join(configDir, "credentials");
    fs.mkdirSync(credentialsDir);
    fs.chmodSync(credentialsDir, 0o700);

    const restored = runGuard("startup", configDir);

    expect(restored.status, JSON.stringify(restored.lines)).toBe(0);
    expect(mode(credentialsDir)).toBe(0o710);

    fs.writeFileSync(path.join(credentialsDir, "token.json"), "secret\n", { mode: 0o600 });

    const nonemptyStartup = runGuard("startup", configDir);

    expect(nonemptyStartup.status, nonemptyStartup.stderr).toBe(0);
    expect(mode(credentialsDir)).toBe(0o710);
    expect(mode(path.join(credentialsDir, "token.json"))).toBe(0o600);
  });

  it("refuses startup traversal when the plan omits the confidential credentials root (#8006)", () => {
    const { configDir } = fixture();
    const credentialsDir = path.join(configDir, "credentials");
    fs.mkdirSync(credentialsDir);
    fs.chmodSync(credentialsDir, 0o700);

    const result = runGuard(
      "startup",
      configDir,
      {},
      {
        ...DEFAULT_PLAN,
        confidentialRoots: [],
      },
    );

    expect(result.status, JSON.stringify(result.lines)).toBe(1);
    expect(result.lines).toContainEqual(
      expect.objectContaining({
        code: "startup-plan-mismatch",
        path: credentialsDir,
      }),
    );
    expect(mode(credentialsDir)).toBe(0o700);
  });

  it("creates a missing sessions carveout during lock so a first-boot agent can write sessions (#7545)", () => {
    const { configDir } = fixture(".openclaw");
    const agentDir = path.join(configDir, "agents", "main");
    const sessionsDir = path.join(agentDir, "sessions");
    const memoryDir = path.join(agentDir, "memory");
    const stagedDir = path.join(configDir, "agents", "second");
    const stagedSessions = path.join(stagedDir, "sessions");
    const pluginsDir = path.join(configDir, "plugins", "nested");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(memoryDir);
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "agent.js"), "export {};\n", { mode: 0o664 });
    fs.symlinkSync("../../plugins/nested", stagedSessions);

    const locked = runGuard("lock", configDir);

    expect(locked.status, locked.stderr).toBe(0);
    expect(fs.statSync(sessionsDir).isDirectory()).toBe(true);
    expect(mode(sessionsDir)).toBe(0o2770);
    expect(fs.lstatSync(stagedSessions).isDirectory()).toBe(true);
    expect(mode(stagedSessions)).toBe(0o2770);
    expect(fs.existsSync(path.join(memoryDir, "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "agents", "sessions"))).toBe(false);

    const sessionPath = path.join(sessionsDir, "active.jsonl");
    fs.writeFileSync(sessionPath, "runtime\n", { mode: 0o660 });
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe("runtime\n");

    const relocked = runGuard("lock", configDir);

    expect(relocked.status, relocked.stderr).toBe(0);
    expect(mode(sessionsDir)).toBe(0o2770);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe("runtime\n");

    const unlocked = runGuard("unlock", configDir);

    expect(unlocked.status, unlocked.stderr).toBe(0);
    expect(mode(sessionsDir)).toBe(0o2770);
  });

  it("fails closed when a sessions entry appears between the carveout check and its mkdir (#7545)", () => {
    const { configDir } = fixture(".openclaw");
    const agentDir = path.join(configDir, "agents", "main");
    fs.mkdirSync(agentDir, { recursive: true });

    const result = spawnSync(
      "python3",
      ["-c", RUN_CARVEOUT_MKDIR_RACE, GUARD_PATH, configDir, PLAN_JSON],
      {
        encoding: "utf-8",
        timeout: 15_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "carveout-create-failed",
            path: path.join(agentDir, "sessions"),
          }),
        ]),
      }),
    );
    expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(false);
  });

  it("keeps a regular-file sessions entry locked instead of creating a writable carveout (#7545)", () => {
    const { configDir } = fixture(".openclaw");
    const agentDir = path.join(configDir, "agents", "main");
    const sessionsPath = path.join(agentDir, "sessions");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(sessionsPath, "not a directory\n", { mode: 0o664 });
    const oldInode = fs.statSync(sessionsPath).ino;

    const locked = runGuard("lock", configDir);

    expect(locked.status, locked.stderr).toBe(0);
    expect(fs.lstatSync(sessionsPath).isFile()).toBe(true);
    expect(mode(sessionsPath)).toBe(0o644);
    expect(fs.statSync(sessionsPath).ino).not.toBe(oldInode);

    const relocked = runGuard("lock", configDir);

    expect(relocked.status, relocked.stderr).toBe(0);
    expect(fs.lstatSync(sessionsPath).isFile()).toBe(true);
    expect(mode(sessionsPath)).toBe(0o644);
  });

  it("rejects hardlinks and special entries during the read-only preflight", () => {
    const { configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const firstPath = path.join(skillsDir, "first.txt");
    fs.mkdirSync(skillsDir);
    fs.writeFileSync(firstPath, "same inode\n");
    fs.linkSync(firstPath, path.join(skillsDir, "second.txt"));
    const fifo = spawnSync("mkfifo", [path.join(skillsDir, "events.fifo")]);
    expect(fifo.status).toBe(0);

    const result = runGuard("preflight", configDir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "issue", code: "hardlinked-entry" }),
        expect.objectContaining({ type: "issue", code: "special-entry" }),
      ]),
    );
  });

  it("contains unsupported state entries during lock without following their targets", () => {
    const { root, configDir } = fixture();
    const skillsDir = path.join(configDir, "skills");
    const firstPath = path.join(skillsDir, "first.txt");
    const secondPath = path.join(skillsDir, "second.txt");
    const fifoPath = path.join(skillsDir, "events.fifo");
    const externalDir = path.join(root, "outside");
    const externalFile = path.join(externalDir, "untouched.txt");
    const escapePath = path.join(skillsDir, "escape");
    const invalidRoot = path.join(configDir, "workspace-host");
    fs.mkdirSync(skillsDir);
    fs.mkdirSync(externalDir);
    fs.writeFileSync(firstPath, "same inode\n");
    fs.linkSync(firstPath, secondPath);
    fs.writeFileSync(externalFile, "untouched\n");
    fs.symlinkSync(externalDir, escapePath);
    fs.symlinkSync(externalDir, invalidRoot);
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);

    const result = runGuard("lock", configDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(firstPath).ino).not.toBe(fs.statSync(secondPath).ino);
    expect(fs.existsSync(fifoPath)).toBe(false);
    expect(fs.existsSync(escapePath)).toBe(false);
    expect(fs.existsSync(invalidRoot)).toBe(false);
    expect(fs.readFileSync(externalFile, "utf-8")).toBe("untouched\n");
    expect(result.lines.at(-1)).toEqual(
      expect.objectContaining({ type: "result", status: "ok", removedEntries: 3 }),
    );
  });
});
