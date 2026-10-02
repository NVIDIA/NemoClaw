// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

describe("legacy empty approvals migration", () => {
  let root: string;
  let config: string;
  let target: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-approvals-"));
    config = path.join(root, "config");
    target = path.join(config, "exec-approvals.json");
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
      "remove_empty_legacy_exec_approvals",
    ).replaceAll("/sandbox/.openclaw", configPath);
    return spawnSync(
      "bash",
      [
        "-c",
        // The temporary state belongs to the test process; image smoke tests cover root step-down.
        `run_openclaw_config_as_owner() { "$@"; }\n${fn}\nremove_empty_legacy_exec_approvals`,
      ],
      { encoding: "utf8" },
    );
  }

  it("rejects a linked config directory without deleting its empty approval file", () => {
    const linked = path.join(root, "linked");
    fs.writeFileSync(target, "");
    fs.symlinkSync(config, linked);
    expect(runMigration(linked).status).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("leaves a missing approvals file absent", () => {
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("removes the empty legacy approvals placeholder", () => {
    fs.writeFileSync(target, "");
    const result = runMigration();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    { kind: "populated", content: '{"version":1,"agents":{"main":{}}}' },
    { kind: "malformed", content: "{not valid" },
    { kind: "whitespace", content: " \n" },
  ])("preserves the $kind approvals file for native migration", ({ content }) => {
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

  it("rejects a directory in place of the approvals file", () => {
    fs.mkdirSync(target);
    expect(runMigration().status).toBe(1);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });
});

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
    ).replaceAll("/sandbox/.openclaw", configPath);
    return spawnSync(
      "bash",
      [
        "-c",
        `run_openclaw_config_as_owner() { "$@"; }\n${fn}\nremove_restored_legacy_device_identity`,
      ],
      { encoding: "utf8" },
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

function doctorFunction(
  source: string,
  configDir: string,
  readyPath: string,
  rootMode = false,
): string {
  return [
    'run_openclaw_config_as_owner() { "$@"; }',
    'STEP_DOWN_PREFIX_SANDBOX=("$STEP_DOWN")',
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "remove_restored_legacy_device_identity").replaceAll(
      "/sandbox/.openclaw",
      configDir,
    ),
    extractShellFunctionFromSource(source, "repair_openclaw_shared_state_schema")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
    extractShellFunctionFromSource(source, "wait_for_openclaw_startup_migration_lease"),
    extractShellFunctionFromSource(source, "run_requested_openclaw_post_upgrade_doctor")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", readyPath)
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
    extractShellFunctionFromSource(source, "consume_openclaw_post_upgrade_release_before_gateway")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", readyPath),
  ].join("\n");
}

const finishDoctorBeforeGateway =
  "run_requested_openclaw_post_upgrade_doctor && consume_openclaw_post_upgrade_release_before_gateway";

function backupQuiesceFunction(source: string, configDir: string, readyPath: string): string {
  return [
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "run_requested_openclaw_backup_quiesce")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", readyPath),
  ].join("\n");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-doctor-"));
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
  fs.mkdirSync(configDir);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.dirname(openclaw), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", "startup-migration-checkpoint-test.js"),
    `import fs from "node:fs";\nexport function hasActiveStartupMigrationLease() { return fs.existsSync(${JSON.stringify(leaseActive)}); }\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", "openclaw-state-db-test.js"),
    [
      `import fs from "node:fs";`,
      `export function repairOpenClawStateDatabaseSchemaIfNeeded() { fs.appendFileSync(new URL("../schema-repair-calls", import.meta.url), "repair\\n"); return { changes: ["migrated"], warnings: [] }; }`,
      `export function repairOpenClawStateDatabaseSchema() { throw new Error("unexpected explicit repair"); }`,
      `export function detectOpenClawStateDatabaseSchemaMigrations() { return []; }`,
      `export function withOpenClawStateStartupMigrationCheckpointDatabase() { throw new Error("unexpected checkpoint"); }`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    openclaw,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\nif [ -n "\${DOCTOR_IDENTITY_CLAIM:-}" ]; then mkdir -p "$(dirname "$DOCTOR_IDENTITY_CLAIM")"; printf '{' >"$DOCTOR_IDENTITY_CLAIM"; fi\nexit "\${DOCTOR_EXIT_CODE:-0}"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "stat"),
    `#!/bin/sh\npython3 - "$2" "$3" <<'PY'\nimport os, stat, sys\ns = os.stat(sys.argv[2], follow_symlinks=False)\nvalues = {"%u": str(s.st_uid), "%u %h": f"{s.st_uid} {s.st_nlink}", "%u %a %h": f"{s.st_uid} {stat.S_IMODE(s.st_mode):o} {s.st_nlink}"}\nprint(values[sys.argv[1]])\nPY\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    stepDown,
    `#!/bin/sh\nprintf 'HOME=%s\\nPATH=%s\\n' "$HOME" "$PATH" >>${JSON.stringify(stepDownCalls)}\nprintf 'ARG=%s\\n' "$@" >>${JSON.stringify(stepDownCalls)}\nexec "$@"\n`,
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
    OPENCLAW: f.openclaw,
    PATH: `${f.fakeBin}:${process.env.PATH ?? ""}`,
    STEP_DOWN: f.stepDown,
  };
}

function releaseAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.release`;
  return [
    `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${JSON.stringify(staged)}`,
    `chmod 600 ${JSON.stringify(staged)}`,
    `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
  ].join("; ");
}

function restoreIdentityAndReleaseAfterReady(
  f: ReturnType<typeof fixture>,
  restoredIdentity: string,
): string {
  const staged = `${f.marker}.release`;
  return [
    `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
    `mkdir -p ${JSON.stringify(path.dirname(restoredIdentity))}`,
    `printf '%s' '{"version":1,"deviceId":"retired-sandbox","privateKeyPem":"private"}' >${JSON.stringify(restoredIdentity)}`,
    `printf '%s\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${JSON.stringify(staged)}`,
    `chmod 600 ${JSON.stringify(staged)}`,
    `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
  ].join("; ");
}

function promoteAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.promote`;
  return [
    `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\n' nemoclaw-openclaw-backup-quiesce-promote-doctor-v1 >${JSON.stringify(staged)}`,
    `chmod 600 ${JSON.stringify(staged)}`,
    `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
  ].join("; ");
}

describe("nemoclaw-start post-upgrade doctor", () => {
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
          `${backupQuiesceFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\nrun_requested_openclaw_backup_quiesce`,
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
            backupQuiesceFunction(source, f.configDir, f.ready),
            doctorFunction(source, f.configDir, f.ready),
            promoteAfterReady(f),
            "run_requested_openclaw_backup_quiesce || exit $?",
            `printf '%s' '{"version":1,"deviceId":"retired-sandbox","privateKeyPem":"private"}' >${JSON.stringify(restoredIdentity)}`,
            `printf 'restored-before-doctor\\n' >${JSON.stringify(f.calls)}`,
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
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
        ],
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
          `${doctorFunction(source, f.configDir, f.ready)}\n${restoreIdentityAndReleaseAfterReady(f, restoredIdentity)}\n${finishDoctorBeforeGateway}`,
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
            doctorFunction(source, f.configDir, f.ready),
            releaseAfterReady(f),
            "run_requested_openclaw_post_upgrade_doctor || exit $?",
            `mkdir -p ${JSON.stringify(path.dirname(lateIdentity))}`,
            `printf '%s' '{"version":1,"deviceId":"late-retired-sandbox","privateKeyPem":"private"}' >${JSON.stringify(lateIdentity)}`,
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
            doctorFunction(source, f.configDir, f.ready),
            releaseAfterReady(f),
            "run_requested_openclaw_post_upgrade_doctor || exit $?",
            `printf '%s\n' unexpected >${JSON.stringify(f.marker)}`,
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
            `${doctorFunction(source, f.configDir, f.ready, true)}\n${release}run_requested_openclaw_post_upgrade_doctor${doctorExitCode === "0" ? " && consume_openclaw_post_upgrade_release_before_gateway" : ""}`,
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

  it("consumes an exact trusted marker only after doctor succeeds", () => {
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
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
        ],
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

  it("repairs a legacy shared state schema before running doctor", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
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
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(f.schemaRepairCalls, "utf8")).toBe("repair\nrepair\n");
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "doctor --fix --yes --non-interactive\ndoctor --fix --yes --non-interactive\n",
      );
      expect(result.stderr).toContain("OpenClaw repaired 1 shared state schema change(s)");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("converges the OpenClaw 2026.6.10 database missing its audit ledger", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      fs.mkdirSync(path.join(f.configDir, "state"));
      const database = path.join(f.configDir, "state", "openclaw.sqlite");
      fs.writeFileSync(database, "legacy-v1");
      fs.writeFileSync(
        path.join(f.packageRoot, "dist", "openclaw-state-db-test.js"),
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
        path.join(f.packageRoot, "dist", "openclaw-state-db-cache-test.js"),
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
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
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
  });

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
          `printf '%s\\n' "$*" >>${JSON.stringify(f.calls)}`,
          `if [ ! -e ${JSON.stringify(firstPass)} ]; then`,
          `  : >${JSON.stringify(firstPass)}`,
          "  exit 7",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\n${finishDoctorBeforeGateway}`,
        ],
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

  it("publishes doctor readiness only after OpenClaw releases its startup lease", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
        mode: 0o600,
      });
      fs.writeFileSync(f.leaseActive, "active\n");
      const staged = `${f.marker}.release`;
      const releaseAfterLease = [
        `(while [ ! -f ${JSON.stringify(f.calls)} ]; do /bin/sleep 0.01; done`,
        `/bin/sleep 0.5`,
        `[ ! -e ${JSON.stringify(f.ready)} ] || : >${JSON.stringify(f.leaseViolation)}`,
        `rm -f -- ${JSON.stringify(f.leaseActive)}`,
        `while [ ! -f ${JSON.stringify(f.ready)} ]; do /bin/sleep 0.01; done`,
        `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${JSON.stringify(staged)}`,
        `chmod 600 ${JSON.stringify(staged)}`,
        `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
      ].join("; ");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nsleep() { /bin/sleep 0.01; }\n${releaseAfterLease}\n${finishDoctorBeforeGateway}`,
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
  });

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
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
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
        `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
        `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-abort-v1 >${JSON.stringify(staged)}`,
        `chmod 600 ${JSON.stringify(staged)}`,
        `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
      ].join("; ");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\n${abortAfterReady}\nrun_requested_openclaw_post_upgrade_doctor`,
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
      const boundedFunction = doctorFunction(source, f.configDir, f.ready).replace(
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
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
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
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
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
