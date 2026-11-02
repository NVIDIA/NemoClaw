// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shellQuote } from "../../../../src/lib/core/shell-quote";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

import {
  seedNativeRetiredAdmission,
  seedRetiredAdmissionFailure,
  seedRepairOrLeaseFailure,
} from "../../../support/openclaw-startup-doctor-failures";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

describe.each(["exec-approvals.json", "update-check.json"])(
  "legacy empty %s migration",
  (filename) => {
    let root: string;
    let config: string;
    let target: string;
    let outside: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-approvals-"));
      config = path.join(root, "config");
      target = path.join(config, filename);
      outside = path.join(root, "outside");
      fs.mkdirSync(config);
      fs.writeFileSync(outside, "");
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function runMigration(configPath = config) {
      const fn = extractShellFunctionFromSource(
        fs.readFileSync(START_SCRIPT, "utf8"),
        "remove_empty_legacy_state_placeholders",
      ).replaceAll("/sandbox/.openclaw", '"$NEMOCLAW_TEST_CONFIG_DIR"');
      return spawnSync(
        "bash",
        [
          "-c",
          // The temporary state belongs to the test process; image smoke tests cover root step-down.
          `run_openclaw_config_as_owner() { "$@"; }\n${fn}\nremove_empty_legacy_state_placeholders`,
        ],
        { encoding: "utf8", env: { ...process.env, NEMOCLAW_TEST_CONFIG_DIR: configPath } },
      );
    }

    it("rejects a linked config directory without deleting its empty placeholder", () => {
      const linked = path.join(root, "linked");
      fs.writeFileSync(target, "");
      fs.symlinkSync(config, linked);
      expect(runMigration(linked).status).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("");
    });

    it("leaves a missing placeholder absent", () => {
      const result = runMigration();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("removes the empty legacy placeholder", () => {
      fs.writeFileSync(target, "");
      const result = runMigration();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });

    it.each([
      { kind: "populated", content: '{"version":1,"agents":{"main":{}}}' },
      { kind: "malformed", content: "{not valid" },
      { kind: "whitespace", content: " \n" },
    ])("preserves the $kind state file for native migration", ({ content }) => {
      fs.writeFileSync(target, content);
      const result = runMigration();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(target, "utf8")).toBe(content);
    });

    it.each([
      { kind: "symlink", create: fs.symlinkSync },
      { kind: "hardlink", create: fs.linkSync },
    ])("rejects a $kind without deleting or changing authorization data", ({ create }) => {
      create(outside, target);
      expect(runMigration().status).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("");
      expect(fs.readFileSync(outside, "utf8")).toBe("");
    });

    it("rejects a directory in place of the placeholder", () => {
      fs.mkdirSync(target);
      expect(runMigration().status).toBe(1);
      expect(fs.statSync(target).isDirectory()).toBe(true);
    });
  },
);

describe("sanitized legacy device identity migration", () => {
  let root: string;
  let config: string;
  let identity: string;
  let target: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sanitized-identity-"));
    config = path.join(root, "config");
    identity = path.join(config, "identity");
    target = path.join(identity, "device.json");
    outside = path.join(root, "outside");
    fs.mkdirSync(identity, { recursive: true });
    fs.writeFileSync(outside, JSON.stringify({ nemoclawSanitizedDeviceIdentity: 1 }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runMigration(configPath = config) {
    const fn = extractShellFunctionFromSource(
      fs.readFileSync(START_SCRIPT, "utf8"),
      "remove_restored_legacy_device_identity",
    ).replaceAll("/sandbox/.openclaw", '"$NEMOCLAW_TEST_CONFIG_DIR"');
    return spawnSync(
      "bash",
      [
        "-c",
        `run_openclaw_config_as_owner() { "$@"; }\n${fn}\nremove_restored_legacy_device_identity`,
      ],
      { encoding: "utf8", env: { ...process.env, NEMOCLAW_TEST_CONFIG_DIR: configPath } },
    );
  }

  it("removes only the explicit sanitized identity placeholder", () => {
    fs.writeFileSync(target, `${JSON.stringify({ nemoclawSanitizedDeviceIdentity: 1 })}   `);
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(result.stderr).toContain("Removed sanitized legacy device identity placeholder");
  });

  it.each([
    { encoding: "empty", content: "" },
    { encoding: "one-byte", content: "{" },
    {
      encoding: "complete",
      content: JSON.stringify({
        version: 1,
        deviceId: "device",
        publicKeyPem: "public",
        privateKeyPem: "private",
      }),
    },
  ])(
    "rotates a restored $encoding identity during trusted post-upgrade maintenance",
    ({ content }) => {
      fs.writeFileSync(
        path.join(config, ".nemoclaw-post-upgrade-doctor"),
        "nemoclaw-openclaw-post-upgrade-doctor-v2\n",
        { mode: 0o600 },
      );
      fs.writeFileSync(target, content);

      const result = runMigration();

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(target)).toBe(false);
      expect(result.stderr).toContain(
        "Removed restored legacy device identity for post-upgrade rotation",
      );
    },
  );

  it.each(["device.json.doctor-importing", "device.json.native-importing"])(
    "rotates a restored interrupted-import claim at %s during trusted maintenance",
    (name) => {
      fs.writeFileSync(
        path.join(config, ".nemoclaw-post-upgrade-doctor"),
        "nemoclaw-openclaw-post-upgrade-doctor-v2\n",
        { mode: 0o600 },
      );
      const claim = path.join(identity, name);
      fs.writeFileSync(claim, "{");

      const result = runMigration();

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(claim)).toBe(false);
      expect(result.stderr).toContain(
        `Removed restored legacy device identity for post-upgrade rotation: ${name}`,
      );
    },
  );

  it("preserves an interrupted-import claim outside trusted maintenance", () => {
    const claim = path.join(identity, "device.json.native-importing");
    fs.writeFileSync(claim, "{");

    const result = runMigration();

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(claim, "utf8")).toBe("{");
  });

  it("rejects an untrusted post-upgrade marker without removing the identity", () => {
    const marker = path.join(config, ".nemoclaw-post-upgrade-doctor");
    fs.writeFileSync(marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
      mode: 0o644,
    });
    fs.writeFileSync(target, JSON.stringify({ version: 1, deviceId: "device" }));

    const result = runMigration();

    expect(result.status).toBe(1);
    expect(fs.existsSync(target)).toBe(true);
  });

  it.each([
    {
      kind: "valid identity",
      content: { version: 1, deviceId: "device", privateKeyPem: "private" },
    },
    { kind: "other object", content: {} },
    {
      kind: "lookalike marker",
      content: { nemoclawSanitizedDeviceIdentity: 2 },
    },
  ])("preserves a $kind", ({ content }) => {
    const serialized = JSON.stringify(content);
    fs.writeFileSync(target, serialized);
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(serialized);
  });

  it("preserves malformed identity data", () => {
    fs.writeFileSync(target, "{not valid");
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("{not valid");
  });

  it.each(["", "{"])("preserves a tiny malformed identity outside maintenance", (content) => {
    fs.writeFileSync(target, content);
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it.each([
    '{ "nemoclawSanitizedDeviceIdentity": 1 }',
    '{"nemoclawSanitizedDeviceIdentity":2,"nemoclawSanitizedDeviceIdentity":1}',
    '{"nemoclawSanitizedDeviceIdentity":1}\n',
  ])("preserves a JSON-equivalent marker not emitted by the sanitizer", (content) => {
    fs.writeFileSync(target, content);
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it.each([
    { kind: "symlink", create: fs.symlinkSync },
    { kind: "hardlink", create: fs.linkSync },
  ])("rejects a $kind without deleting the target", ({ create }) => {
    create(outside, target);
    expect(runMigration().status).toBe(1);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("rejects a linked identity directory", () => {
    fs.rmSync(identity, { recursive: true });
    const outsideDirectory = path.join(root, "outside-identity");
    fs.mkdirSync(outsideDirectory);
    const outsideTarget = path.join(outsideDirectory, "device.json");
    fs.writeFileSync(outsideTarget, JSON.stringify({ nemoclawSanitizedDeviceIdentity: 1 }));
    fs.symlinkSync(outsideDirectory, identity);
    expect(runMigration().status).toBe(1);
    expect(fs.existsSync(outsideTarget)).toBe(true);
  });
});

function doctorFunction(source: string, rootMode = false): string {
  return [
    'run_openclaw_config_as_owner() { "$@"; }',
    'STEP_DOWN_PREFIX_SANDBOX=("$STEP_DOWN")',
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "remove_restored_legacy_device_identity").replaceAll(
      "/sandbox/.openclaw",
      "${NEMOCLAW_TEST_CONFIG_DIR}",
    ),
    extractShellFunctionFromSource(source, "repair_openclaw_shared_state_schema")
      .replaceAll("/sandbox/.openclaw", "${NEMOCLAW_TEST_CONFIG_DIR}")
      .replace(
        'const databasePath = "${NEMOCLAW_TEST_CONFIG_DIR}/state/openclaw.sqlite";',
        'const databasePath = process.env.NEMOCLAW_TEST_CONFIG_DIR + "/state/openclaw.sqlite";',
      )
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
    extractShellFunctionFromSource(source, "wait_for_openclaw_startup_migration_lease"),
    extractShellFunctionFromSource(source, "run_openclaw_legacy_migrations")
      .replace(
        "/usr/local/lib/nemoclaw/openclaw-legacy-migrations.mts",
        '"$NEMOCLAW_TEST_MIGRATION_RUNNER"',
      )
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
    extractShellFunctionFromSource(source, "run_requested_openclaw_post_upgrade_doctor")
      .replaceAll("/sandbox/.openclaw", "${NEMOCLAW_TEST_CONFIG_DIR}")
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", "${NEMOCLAW_TEST_READY}")
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
    extractShellFunctionFromSource(source, "consume_openclaw_post_upgrade_release_before_gateway")
      .replaceAll("/sandbox/.openclaw", "${NEMOCLAW_TEST_CONFIG_DIR}")
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", "${NEMOCLAW_TEST_READY}"),
  ]
    .join("\n")
    .replaceAll(" ${NEMOCLAW_TEST_CONFIG_DIR}", ' "${NEMOCLAW_TEST_CONFIG_DIR}"');
}

const finishDoctorBeforeGateway =
  "run_requested_openclaw_post_upgrade_doctor && consume_openclaw_post_upgrade_release_before_gateway";

function backupQuiesceFunction(source: string): string {
  return [
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "run_openclaw_config_as_owner"),
    extractShellFunctionFromSource(source, "run_requested_openclaw_backup_quiesce")
      .replace("/usr/local/bin/node", shellQuote(process.execPath))
      .replace(
        "/usr/local/lib/nemoclaw/openclaw-legacy-migrations.mts",
        '"$NEMOCLAW_TEST_OWNER_RUNNER"',
      )
      .replaceAll("/sandbox/.openclaw", "${NEMOCLAW_TEST_CONFIG_DIR}")
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", "${NEMOCLAW_TEST_READY}"),
  ]
    .join("\n")
    .replaceAll(" ${NEMOCLAW_TEST_CONFIG_DIR}", ' "${NEMOCLAW_TEST_CONFIG_DIR}"');
}

function fixture(moduleExtension = "js", native105 = false, prefix = "nemoclaw-start-doctor-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, "openclaw");
  const marker = path.join(configDir, ".nemoclaw-post-upgrade-doctor");
  const ready = path.join(root, "doctor-ready");
  const calls = path.join(root, "calls");
  const nodeModules = path.join(root, "node_modules");
  const packageRoot = path.join(nodeModules, "openclaw");
  const openclaw = path.join(nodeModules, ".bin", "openclaw");
  const fakeBin = path.join(root, "bin");
  const stepDown = path.join(root, "step-down");
  const stepDownCalls = path.join(root, "step-down-calls");
  const leaseActive = path.join(root, "lease-active");
  const leaseViolation = path.join(root, "lease-violation");
  const schemaRepairCalls = path.join(packageRoot, "schema-repair-calls");
  const ownerRunner = path.join(root, "owner-probe.mjs");
  fs.mkdirSync(configDir);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.dirname(openclaw), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    ownerRunner,
    [
      'import fs from "node:fs";',
      'import assert from "node:assert/strict";',
      'assert.deepEqual(process.argv.slice(2), ["--wait-gateway-executable", process.env.OPENCLAW, "2026.10.5"]);',
      "assert.equal(fs.existsSync(process.env.NEMOCLAW_TEST_READY), false);",
      'process.exit(Number(process.env.NEMOCLAW_TEST_OWNER_EXIT ?? "0"));',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", version: "2026.9.5" }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", `startup-migration-checkpoint-test.${moduleExtension}`),
    `import fs from "node:fs";\nfunction hasActiveStartupMigrationLease() { return fs.existsSync(${JSON.stringify(leaseActive)}); }\nexport { hasActiveStartupMigrationLease${native105 ? " as i" : ""} };\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", `openclaw-state-db-test.${moduleExtension}`),
    [
      `import fs from "node:fs";`,
      `export ${native105 ? "async function prepareOpenClawStateDatabaseSchema" : "function repairOpenClawStateDatabaseSchemaIfNeeded"}() { ${native105 ? "await new Promise((resolve) => setTimeout(resolve, 10));" : ""} fs.appendFileSync(new URL("../schema-repair-calls", import.meta.url), "repair\\n"); return { changes: ["migrated"], warnings: [] }; }`,
      `export function repairOpenClawStateDatabaseSchema() { throw new Error("unexpected explicit repair"); }`,
      `export function detectOpenClawStateDatabaseSchemaMigrations() { return []; }`,
      `export function withOpenClawStateStartupMigrationCheckpointDatabase() { throw new Error("unexpected checkpoint"); }`,
      "",
    ].join("\n"),
  );
  seedNativeRetiredAdmission(packageRoot, moduleExtension, native105);
  fs.writeFileSync(
    openclaw,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${shellQuote(calls)}\nif [ -n "\${DOCTOR_IDENTITY_CLAIM:-}" ]; then mkdir -p "$(dirname "$DOCTOR_IDENTITY_CLAIM")"; printf '{' >"$DOCTOR_IDENTITY_CLAIM"; fi\nexit "\${DOCTOR_EXIT_CODE:-0}"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "stat"),
    `#!/bin/sh\npython3 - "$2" "$3" <<'PY'\nimport os, stat, sys\ns = os.stat(sys.argv[2], follow_symlinks=False)\nvalues = {"%u": str(s.st_uid), "%u %h": f"{s.st_uid} {s.st_nlink}", "%u %a %h": f"{s.st_uid} {stat.S_IMODE(s.st_mode):o} {s.st_nlink}"}\nprint(values[sys.argv[1]])\nPY\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    stepDown,
    `#!/bin/sh\nprintf 'HOME=%s\\nPATH=%s\\n' "$HOME" "$PATH" >>${shellQuote(stepDownCalls)}\nprintf 'ARG=%s\\n' "$@" >>${shellQuote(stepDownCalls)}\nexec "$@"\n`,
    { mode: 0o755 },
  );
  return {
    calls,
    configDir,
    fakeBin,
    leaseActive,
    leaseViolation,
    marker,
    openclaw,
    ownerRunner,
    packageRoot,
    ready,
    root,
    schemaRepairCalls,
    stepDown,
    stepDownCalls,
  };
}

function fixtureEnv(
  f: ReturnType<typeof fixture>,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    NEMOCLAW_TEST_CONFIG_DIR: f.configDir,
    NEMOCLAW_TEST_READY: f.ready,
    NEMOCLAW_TEST_MIGRATION_RUNNER: path.resolve(
      import.meta.dirname,
      "../../../../scripts/lib/openclaw-legacy-migrations.mts",
    ),
    OPENCLAW: f.openclaw,
    NEMOCLAW_TEST_OWNER_RUNNER: f.ownerRunner,
    PATH: `${f.fakeBin}:${process.env.PATH ?? ""}`,
    STEP_DOWN: f.stepDown,
  };
}

function releaseAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.release`;
  return [
    `(while [ ! -f ${shellQuote(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${shellQuote(staged)}`,
    `chmod 600 ${shellQuote(staged)}`,
    `mv -f -- ${shellQuote(staged)} ${shellQuote(f.marker)}) &`,
  ].join("; ");
}

function restoreIdentityAndReleaseAfterReady(
  f: ReturnType<typeof fixture>,
  restoredIdentity: string,
): string {
  const staged = `${f.marker}.release`;
  return [
    `(while [ ! -f ${shellQuote(f.ready)} ]; do sleep 0.01; done`,
    `mkdir -p ${shellQuote(path.dirname(restoredIdentity))}`,
    `printf '%s' '{"version":1,"deviceId":"retired-sandbox","privateKeyPem":"private"}' >${shellQuote(restoredIdentity)}`,
    `printf '%s\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${shellQuote(staged)}`,
    `chmod 600 ${shellQuote(staged)}`,
    `mv -f -- ${shellQuote(staged)} ${shellQuote(f.marker)}) &`,
  ].join("; ");
}

function promoteAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.promote`;
  return [
    `(while [ ! -f ${shellQuote(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\n' nemoclaw-openclaw-backup-quiesce-promote-doctor-v1 >${shellQuote(staged)}`,
    `chmod 600 ${shellQuote(staged)}`,
    `mv -f -- ${shellQuote(staged)} ${shellQuote(f.marker)}) &`,
  ].join("; ");
}

describe("nemoclaw-start post-upgrade doctor", () => {
  it("treats shell metacharacters in fixture paths as data", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture("js", false, "nemoclaw-$(touch${IFS}injected)-'` space-");
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`],
        { encoding: "utf8", env: fixtureEnv(f), cwd: f.root, timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(fs.existsSync(path.join(f.root, "injected"))).toBe(false);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([0, 7])(
    "hands off 10.5 legacy migration before Doctor under sandbox step-down (exit %s)",
    (migrationExitCode) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture("mjs", true);
      try {
        const coordinator = path.resolve(
          import.meta.dirname,
          "../../../../scripts/lib/openclaw-legacy-migrations.mts",
        );
        const node = path.join(f.fakeBin, "node");
        const receipt = path.join(f.root, "migration-call.json");
        fs.writeFileSync(
          path.join(f.packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module", version: "2026.10.5" }),
        );
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(f.configDir, "state"));
        const database = path.join(f.configDir, "state/openclaw.sqlite");
        fs.writeFileSync(database, "preserve-restored-state");
        // Observe the production wrapper's callee boundary; native coordinator
        // behavior is covered separately, including the refusal test below.
        fs.writeFileSync(
          node,
          `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(coordinator)}) {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, home: process.env.HOME, path: process.env.PATH }));
  fs.appendFileSync(${JSON.stringify(f.calls)}, "migration\\n");
  process.exit(${migrationExitCode});
}
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
          { mode: 0o755 },
        );
        const env = fixtureEnv(f, { HOME: f.root });
        const release =
          migrationExitCode === 0
            ? `${releaseAfterReady(f)}\nrelease_pid=$!\ntrap 'kill "$release_pid" 2>/dev/null || true; wait "$release_pid" 2>/dev/null || true' EXIT\n`
            : "";
        const result = spawnSync(
          "bash",
          ["-c", `${doctorFunction(source, true)}\n${release}${finishDoctorBeforeGateway}`],
          { encoding: "utf8", env, timeout: 10_000 },
        );

        const args = [
          coordinator,
          "--run-executable",
          f.openclaw,
          "/usr/local/lib/nemoclaw/openclaw-migrations",
        ];
        expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual({
          args,
          home: "/sandbox",
          path: `${env.PATH}:/sandbox/.local/bin`,
        });
        expect(fs.readFileSync(f.stepDownCalls, "utf8")).toContain(
          ["/usr/bin/env", "HOME=/sandbox", `PATH=${env.PATH}:/sandbox/.local/bin`, node, ...args]
            .map((arg) => `ARG=${arg}\n`)
            .join(""),
        );
        expect(fs.readFileSync(f.calls, "utf8")).toBe(
          migrationExitCode === 0
            ? "migration\ndoctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n"
            : "migration\n",
        );
        expect(fs.existsSync(f.schemaRepairCalls)).toBe(migrationExitCode === 0);
        expect(result.status, result.stderr).toBe(migrationExitCode === 0 ? 0 : 1);
        expect(fs.existsSync(f.ready)).toBe(false);
        expect(fs.existsSync(f.marker)).toBe(migrationExitCode !== 0);
        expect(fs.readFileSync(database, "utf8")).toBe("preserve-restored-state");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the gate closed before schema repair when intermediate inspection fails", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture("mjs", true);
    try {
      fs.writeFileSync(
        path.join(f.packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module", version: "2026.10.5" }),
      );
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      fs.mkdirSync(path.join(f.configDir, "state"));
      const database = path.join(f.configDir, "state/openclaw.sqlite");
      fs.writeFileSync(database, "preserve-original-database");
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        { encoding: "utf8", env: fixtureEnv(f) },
      );
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(database, "utf8")).toBe("preserve-original-database");
      expect(fs.existsSync(f.schemaRepairCalls)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.marker)).toBe(true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("holds backup state before startup mutation without invoking doctor", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-backup-quiesce-v1\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${backupQuiesceFunction(source)}\n${releaseAfterReady(f)}\nrun_requested_openclaw_backup_quiesce`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not publish backup readiness when native ownership remains unverified", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-backup-quiesce-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        ["-c", `${backupQuiesceFunction(source)}\nrun_requested_openclaw_backup_quiesce`],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { NEMOCLAW_TEST_OWNER_EXIT: "1" }),
        },
      );
      expect(result.status).toBe(1);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-backup-quiesce-v1\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("runs doctor only after a quiesced restore is promoted", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-backup-quiesce-v1\n", {
        mode: 0o600,
      });
      const restoredIdentity = path.join(f.configDir, "identity", "device.json");
      fs.mkdirSync(path.dirname(restoredIdentity));
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            backupQuiesceFunction(source),
            doctorFunction(source),
            promoteAfterReady(f),
            "run_requested_openclaw_backup_quiesce || exit $?",
            `printf '%s' '{"version":1,"deviceId":"retired-sandbox","privateKeyPem":"private"}' >${shellQuote(restoredIdentity)}`,
            `printf 'restored-before-doctor\\n' >${shellQuote(f.calls)}`,
            releaseAfterReady(f),
            finishDoctorBeforeGateway,
          ].join("\n"),
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "restored-before-doctor\ndoctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(fs.existsSync(restoredIdentity)).toBe(false);
      expect(result.stderr).toContain(
        "Removed restored legacy device identity for post-upgrade rotation",
      );
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rotates an invalid interrupted-import claim left by doctor before gateway release", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const claim = path.join(f.configDir, "identity", "device.json.native-importing");
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { DOCTOR_IDENTITY_CLAIM: claim }),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(claim)).toBe(false);
      expect(result.stderr).toContain(
        "Removed restored legacy device identity for post-upgrade rotation: device.json.native-importing",
      );
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rotates a legacy identity restored after doctor before gateway release", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const restoredIdentity = path.join(f.configDir, "identity", "device.json");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source)}\n${restoreIdentityAndReleaseAfterReady(f, restoredIdentity)}\n${finishDoctorBeforeGateway}`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(restoredIdentity)).toBe(false);
      expect(result.stderr).toContain(
        "Removed restored legacy device identity for post-upgrade rotation: device.json",
      );
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rotates an identity materialized after release acceptance at the gateway launch edge", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const lateIdentity = path.join(f.configDir, "identity", "device.json");
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            doctorFunction(source),
            releaseAfterReady(f),
            "run_requested_openclaw_post_upgrade_doctor || exit $?",
            `mkdir -p ${shellQuote(path.dirname(lateIdentity))}`,
            `printf '%s' '{"version":1,"deviceId":"late-retired-sandbox","privateKeyPem":"private"}' >${shellQuote(lateIdentity)}`,
            "consume_openclaw_post_upgrade_release_before_gateway",
          ].join("\n"),
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(lateIdentity)).toBe(false);
      expect(result.stderr).toContain("release accepted; final identity rotation pending");
      expect(result.stderr).toContain(
        "Removed restored legacy device identity for post-upgrade rotation: device.json",
      );
      expect(result.stderr).toContain("released gateway launch");
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a replaced release marker at the gateway launch edge", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            doctorFunction(source),
            releaseAfterReady(f),
            "run_requested_openclaw_post_upgrade_doctor || exit $?",
            `printf '%s\n' unexpected >${shellQuote(f.marker)}`,
            "consume_openclaw_post_upgrade_release_before_gateway",
          ].join("\n"),
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing unsafe restored device identity migration");
      expect(fs.readFileSync(f.marker, "utf8")).toBe("unexpected\n");
      expect(fs.existsSync(f.ready)).toBe(true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { doctorExitCode: "0", expectedStatus: 0, markerRetained: false },
    { doctorExitCode: "7", expectedStatus: 1, markerRetained: true },
  ])(
    "uses the sandbox identity and environment in root mode (doctor exit $doctorExitCode)",
    ({ doctorExitCode, expectedStatus, markerRetained }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture();
      try {
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        const release = doctorExitCode === "0" ? `${releaseAfterReady(f)}\n` : "";
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${doctorFunction(source, true)}\n${release}run_requested_openclaw_post_upgrade_doctor${doctorExitCode === "0" ? " && consume_openclaw_post_upgrade_release_before_gateway" : ""}`,
          ],
          {
            encoding: "utf8",
            env: fixtureEnv(f, { DOCTOR_EXIT_CODE: doctorExitCode }),
          },
        );

        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(fs.existsSync(f.marker)).toBe(markerRetained);
        const stepDown = fs.readFileSync(f.stepDownCalls, "utf8");
        expect(stepDown).toContain("HOME=/sandbox\n");
        expect(stepDown).toContain(`ARG=PATH=`);
        expect(stepDown).toContain(f.fakeBin);
        expect(stepDown).toContain("/sandbox/.local/bin\n");
        expect(stepDown).toContain(`ARG=${f.openclaw}\n`);
        expect(stepDown).toContain("ARG=doctor\nARG=--fix\nARG=--yes\nARG=--non-interactive\n");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { gate: "doctor", replacement: "trusted", expectedStatus: 0 },
    { gate: "backup", replacement: "trusted", expectedStatus: 0 },
    { gate: "doctor", replacement: "wrong mode", expectedStatus: 1 },
    { gate: "backup", replacement: "wrong mode", expectedStatus: 1 },
    { gate: "doctor", replacement: "hardlink", expectedStatus: 1 },
    { gate: "backup", replacement: "hardlink", expectedStatus: 1 },
    { gate: "doctor", replacement: "symlink", expectedStatus: 1 },
    { gate: "backup", replacement: "symlink", expectedStatus: 1 },
  ])(
    "rechecks a $replacement replacement when the $gate gate observes an unlinked marker",
    ({ gate, replacement, expectedStatus }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture();
      try {
        fs.writeFileSync(
          f.marker,
          gate === "doctor"
            ? "nemoclaw-openclaw-post-upgrade-doctor-v2\n"
            : "nemoclaw-openclaw-backup-quiesce-v1\n",
          { mode: 0o600 },
        );
        const staged = `${f.marker}.replacement`;
        fs.writeFileSync(staged, "nemoclaw-openclaw-post-upgrade-doctor-release-v1\n", {
          mode: replacement === "wrong mode" ? 0o644 : 0o600,
        });
        const prepareReplacement: Record<string, () => void> = {
          trusted: () => {},
          "wrong mode": () => {},
          hardlink: () => fs.linkSync(staged, `${staged}.link`),
          symlink: () => {
            fs.renameSync(staged, `${staged}.target`);
            fs.symlinkSync(`${staged}.target`, staged);
          },
        };
        prepareReplacement[replacement]();
        const statPath = path.join(f.fakeBin, "stat");
        // Linux path stat can retain the old inode across an atomic rename.
        // Hold that inode open to reproduce its zero-link metadata deterministically.
        fs.writeFileSync(
          statPath,
          fs
            .readFileSync(statPath, "utf8")
            .replace(
              "s = os.stat(sys.argv[2], follow_symlinks=False)",
              [
                "marker = os.environ['RACE_MARKER']",
                "staged = marker + '.replacement'",
                "if sys.argv[2] == marker and os.path.exists(os.environ['RACE_READY']) and os.path.lexists(staged):",
                "    with open(marker) as old:",
                "        os.replace(staged, marker)",
                "        s = os.fstat(old.fileno())",
                "else:",
                "    s = os.stat(sys.argv[2], follow_symlinks=False)",
              ].join("\n"),
            ),
        );
        const functions =
          gate === "doctor" ? doctorFunction(source) : backupQuiesceFunction(source);
        const command =
          gate === "doctor" ? finishDoctorBeforeGateway : "run_requested_openclaw_backup_quiesce";
        const result = spawnSync("bash", ["-c", `${functions}\n${command}`], {
          encoding: "utf8",
          env: fixtureEnv(f, { RACE_MARKER: f.marker, RACE_READY: f.ready }),
          timeout: 10_000,
        });

        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(fs.existsSync(staged)).toBe(false);
        expect(fs.existsSync(f.marker)).toBe(expectedStatus !== 0);
        expect(fs.existsSync(f.calls)).toBe(gate === "doctor");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["doctor", "backup"])(
    "cleans the %s gate when every metadata snapshot is unlinked",
    (gate) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture();
      try {
        fs.writeFileSync(
          f.marker,
          gate === "doctor"
            ? "nemoclaw-openclaw-post-upgrade-doctor-v2\n"
            : "nemoclaw-openclaw-backup-quiesce-v1\n",
          { mode: 0o600 },
        );
        const statPath = path.join(f.fakeBin, "stat");
        fs.writeFileSync(
          statPath,
          fs
            .readFileSync(statPath, "utf8")
            .replace(
              "print(values[sys.argv[1]])",
              [
                "if sys.argv[2] == os.environ['RACE_MARKER'] and os.path.exists(os.environ['RACE_READY']):",
                '    print(f"{s.st_uid} 600 0")',
                "else:",
                "    print(values[sys.argv[1]])",
              ].join("\n"),
            ),
        );
        const functions = (
          gate === "doctor" ? doctorFunction(source) : backupQuiesceFunction(source)
        ).replace('[ "$gate_attempt" -lt 600 ]', '[ "$gate_attempt" -lt 2 ]');
        const command =
          gate === "doctor" ? finishDoctorBeforeGateway : "run_requested_openclaw_backup_quiesce";
        const result = spawnSync(
          "bash",
          ["-c", `${functions}\nsleep() { return 0; }\n${command}`],
          {
            encoding: "utf8",
            env: fixtureEnv(f, { RACE_MARKER: f.marker, RACE_READY: f.ready }),
            timeout: 10_000,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Timed out waiting");
        expect(fs.existsSync(f.marker)).toBe(false);
        expect(fs.existsSync(f.ready)).toBe(false);
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("consumes an exact trusted marker only after doctor succeeds", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(result.stderr).toContain("checking dependent migrations once");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { moduleExtension: "js", native105: false },
    { moduleExtension: "mjs", native105: false },
    { moduleExtension: "mjs", native105: true },
  ])(
    "repairs a legacy shared state schema through $moduleExtension modules before doctor (10.5 API: $native105)",
    ({ moduleExtension, native105 }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture(moduleExtension, native105);
      try {
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(f.configDir, "state"));
        fs.writeFileSync(path.join(f.configDir, "state", "openclaw.sqlite"), "legacy");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
          ],
          { encoding: "utf8", env: fixtureEnv(f) },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(f.schemaRepairCalls, "utf8")).toBe(
          native105 ? "admission\nrepair\nadmission\nrepair\n" : "repair\nrepair\n",
        );
        expect(fs.readFileSync(f.calls, "utf8")).toBe(
          "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
        );
        expect(result.stderr).toContain("OpenClaw repaired 1 shared state schema change(s)");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "retired source rejection",
    "missing admission module",
    "ambiguous admission module",
    "missing admission export",
    "invalid admission export",
  ])("refuses a 10.5 %s before changing the restored schema", (failure) => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture("mjs", true);
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      fs.mkdirSync(path.join(f.configDir, "state"));
      const database = path.join(f.configDir, "state", "openclaw.sqlite");
      fs.writeFileSync(database, "legacy");
      seedRetiredAdmissionFailure(f.packageRoot, failure);
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        { encoding: "utf8", env: fixtureEnv(f), timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Could not repair the OpenClaw shared state schema");
      expect(fs.readFileSync(database, "utf8")).toBe("legacy");
      expect(fs.existsSync(f.schemaRepairCalls)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    "async repair rejection",
    "repair warning",
    "invalid repair result",
    "missing lease export",
    "invalid lease result",
  ])("keeps startup closed for a 10.5 %s", (failure) => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture("mjs", true);
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      fs.mkdirSync(path.join(f.configDir, "state"));
      fs.writeFileSync(path.join(f.configDir, "state", "openclaw.sqlite"), "legacy");
      seedRepairOrLeaseFailure(f.packageRoot, failure);
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        { encoding: "utf8", env: fixtureEnv(f), timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        failure.includes("repair")
          ? "Could not repair the OpenClaw shared state schema"
          : "Could not inspect the OpenClaw startup-migration lease",
      );
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(!failure.includes("repair"));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { moduleExtension: "js", schemaOwner: "cache" },
    { moduleExtension: "mjs", schemaOwner: "core" },
  ])(
    "converges the legacy database using the $schemaOwner canonical schema in $moduleExtension",
    ({ moduleExtension, schemaOwner }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture(moduleExtension);
      try {
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        fs.mkdirSync(path.join(f.configDir, "state"));
        const database = path.join(f.configDir, "state", "openclaw.sqlite");
        fs.writeFileSync(database, "legacy-v1");
        fs.writeFileSync(
          path.join(f.packageRoot, "dist", `openclaw-state-db-test.${moduleExtension}`),
          [
            `import fs from "node:fs";`,
            `const calls = ${JSON.stringify(f.schemaRepairCalls)};`,
            `const bootstrapped = (options) => fs.readFileSync(options.path, "utf8") === "audit-ledger";`,
            `export function repairOpenClawStateDatabaseSchemaIfNeeded(options) { fs.appendFileSync(calls, "conditional\\n"); return { changes: bootstrapped(options) ? [] : ["retired-v7", "retired-v10", "folded-v12"], warnings: [] }; }`,
            `export function repairOpenClawStateDatabaseSchema(options) { fs.appendFileSync(calls, "explicit\\n"); if (!bootstrapped(options)) throw new Error("audit ledger missing"); return { changes: ["v13", "v14", "v15", "schema-version"], warnings: [] }; }`,
            `export function detectOpenClawStateDatabaseSchemaMigrations(options) { return bootstrapped(options) ? [] : ["state-consolidation-v13", "creator-namespace-v14", "conversation-binding-targets-v15"].map((kind) => ({ kind, path: options.path })); }`,
            `export function withOpenClawStateStartupMigrationCheckpointDatabase(callback, options) {`,
            `  callback({`,
            `    prepare(sql) { return { get() { return sql === "PRAGMA user_version" ? { user_version: 1 } : undefined; } }; },`,
            `    exec(sql) { if (sql.includes("CREATE TABLE IF NOT EXISTS audit_identity_keys (")) fs.writeFileSync(options.path, "audit-ledger"); },`,
            `  });`,
            `}`,
            "",
          ].join("\n"),
        );
        fs.writeFileSync(
          path.join(
            f.packageRoot,
            "dist",
            `openclaw-state-db-${schemaOwner}-schema.${moduleExtension}`,
          ),
          [
            "export const schema = `",
            "CREATE TABLE IF NOT EXISTS audit_events (sequence INTEGER PRIMARY KEY);",
            "",
            "CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings (event_id TEXT);",
            "",
            "CREATE TABLE IF NOT EXISTS audit_identity_keys (id INTEGER PRIMARY KEY);",
            "",
            "CREATE TABLE IF NOT EXISTS config_revision_keys (id INTEGER PRIMARY KEY);",
            "",
            "CREATE TABLE IF NOT EXISTS agent_databases (agent_id TEXT);",
            "`;",
            "",
          ].join("\n"),
        );

        const result = spawnSync(
          "bash",
          [
            "-c",
            `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
          ],
          { encoding: "utf8", env: fixtureEnv(f) },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(f.schemaRepairCalls, "utf8")).toBe(
          "conditional\nexplicit\nconditional\n",
        );
        expect(result.stderr).toContain(
          "OpenClaw bootstrapped the missing legacy audit ledger migration boundary",
        );
        expect(result.stderr).toContain("OpenClaw repaired 7 shared state schema change(s)");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("retries once after shared-schema repair reveals dependent migrations", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    const firstPass = path.join(f.root, "doctor-first-pass");
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      fs.writeFileSync(
        f.openclaw,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >>${shellQuote(f.calls)}`,
          `if [ ! -e ${shellQuote(firstPass)} ]; then`,
          `  : >${shellQuote(firstPass)}`,
          "  exit 7",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(result.stderr).toContain("doctor requested a follow-up migration pass");
      expect(fs.existsSync(f.marker)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { moduleExtension: "js", native105: false },
    { moduleExtension: "mjs", native105: false },
    { moduleExtension: "mjs", native105: true },
  ])(
    "publishes doctor readiness only after the $moduleExtension startup lease releases (10.5 API: $native105)",
    ({ moduleExtension, native105 }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture(moduleExtension, native105);
      try {
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        fs.writeFileSync(f.leaseActive, "active\n");
        const staged = `${f.marker}.release`;
        const releaseAfterLease = [
          `(while [ ! -f ${shellQuote(f.calls)} ]; do /bin/sleep 0.01; done`,
          `/bin/sleep 0.5`,
          `[ ! -e ${shellQuote(f.ready)} ] || : >${shellQuote(f.leaseViolation)}`,
          `rm -f -- ${shellQuote(f.leaseActive)}`,
          `while [ ! -f ${shellQuote(f.ready)} ]; do /bin/sleep 0.01; done`,
          `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${shellQuote(staged)}`,
          `chmod 600 ${shellQuote(staged)}`,
          `mv -f -- ${shellQuote(staged)} ${shellQuote(f.marker)}) &`,
        ].join("; ");
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${doctorFunction(source)}\nsleep() { /bin/sleep 0.01; }\n${releaseAfterLease}\n${finishDoctorBeforeGateway}`,
          ],
          { encoding: "utf8", env: fixtureEnv(f) },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(f.leaseViolation)).toBe(false);
        expect(result.stderr).toContain(
          "waiting for OpenClaw startup migrations to release their native lease",
        );
        expect(fs.existsSync(f.marker)).toBe(false);
        expect(fs.existsSync(f.ready)).toBe(false);
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("consumes an abort transition before running doctor and remains stopped", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-abort-v1\n", {
        mode: 0o600,
      });
      fs.writeFileSync(f.ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("consumes an abort transition while the offline gate is armed", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const staged = `${f.marker}.abort`;
      const abortAfterReady = [
        `(while [ ! -f ${shellQuote(f.ready)} ]; do sleep 0.01; done`,
        `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-abort-v1 >${shellQuote(staged)}`,
        `chmod 600 ${shellQuote(staged)}`,
        `mv -f -- ${shellQuote(staged)} ${shellQuote(f.marker)}) &`,
      ].join("; ");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source)}\n${abortAfterReady}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("cleans an abandoned gate on timeout so a future start cannot repeat it", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const boundedFunction = doctorFunction(source).replace(
        '[ "$gate_attempt" -lt 600 ]',
        '[ "$gate_attempt" -lt 2 ]',
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${boundedFunction}\nsleep() { return 0; }\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(result.stderr).toContain("Timed out waiting for post-upgrade offline restore release");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains the marker when doctor fails so recovery can retry", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { DOCTOR_EXIT_CODE: "7" }),
        },
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v2\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["wrong mode", "wrong content"])("rejects a marker with %s", (label) => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      const wrongMode = label === "wrong mode";
      fs.writeFileSync(
        f.marker,
        wrongMode ? "nemoclaw-openclaw-post-upgrade-doctor-v2\n" : "unexpected\n",
        { mode: wrongMode ? 0o644 : 0o600 },
      );
      const result = spawnSync(
        "bash",
        ["-c", `${doctorFunction(source)}\nrun_requested_openclaw_post_upgrade_doctor`],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.existsSync(f.marker)).toBe(true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
