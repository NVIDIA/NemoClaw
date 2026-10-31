// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveEmptyTelegramThreadBindings,
  waitForOpenClawGatewayOwner,
} from "../../../scripts/lib/openclaw-legacy-migrations.mts";

const script = path.resolve(
  import.meta.dirname,
  "../../../scripts/lib/openclaw-legacy-migrations.mts",
);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native ownership before offline state writes", () => {
  function runtime(body: string, leaseBody = "return undefined;") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-owner-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
    );
    fs.writeFileSync(
      path.join(root, "dist/gateway-lock-test.mjs"),
      [
        'import assert from "node:assert/strict";',
        "let calls = 0;",
        "async function readActiveGatewayLockIdentity(options) {",
        "assert.equal(options.requireInspection, true); assert.equal(options.includeEmbedded, true);",
        "assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000); calls++;",
        body,
        "}",
        "export { readActiveGatewayLockIdentity as o };",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "dist/gateway-owner-lease-test.mjs"),
      `import assert from "node:assert/strict";
let calls = 0;
function assertGatewayOwnerLeaseStopped(env) {
  assert.equal(env, process.env); calls++; ${leaseBody}
}
export { assertGatewayOwnerLeaseStopped as n };`,
    );
    return root;
  }

  it.each([
    'throw new Error("Another Gateway owner lease is still active for this state directory: live fixture");',
    'const error = new Error("fresh foreign namespace"); error.name = "GatewayLockNamespaceError"; throw error;',
  ])("keeps startup held while the native lease assertion refuses (%s)", async (body) => {
    let clock = 0;
    await expect(
      waitForOpenClawGatewayOwner(runtime("return undefined;", body), {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/maintenance budget/);
    expect(clock).toBe(120_000);
  });

  it("waits until native process inspection declares the lease owner stopped", async () => {
    let clock = 0;
    await waitForOpenClawGatewayOwner(
      runtime(
        "return undefined;",
        'if (calls < 3) throw new Error("Another Gateway owner lease is still active for this state directory: fixture");',
      ),
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(clock).toBe(4_000);
  });

  it.each(['throw new Error("malformed lease payload");', 'throw new Error("unsafe state");'])(
    "refuses invalid native lease inspection (%s)",
    async (body) => {
      const wait = vi.fn();
      await expect(
        waitForOpenClawGatewayOwner(runtime("return undefined;", body), { sleep: wait }),
      ).rejects.toThrow();
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it.each([
    "if (calls < 3) return { pid: 123 };",
    'if (calls < 3) { const cause = new Error("fresh owner"); cause.name = "GatewayLockNamespaceError"; const error = new Error("inspection unavailable", { cause }); error.name = "GatewayLockError"; throw error; }',
  ])("waits for native proof without changing source state (%s)", async (body) => {
    const root = runtime(body);
    const source = path.join(root, "openclaw.json");
    fs.writeFileSync(source, "malformed config must still be backed up");
    let clock = 0;
    await waitForOpenClawGatewayOwner(root, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(clock).toBe(4000);
    expect(fs.readFileSync(source, "utf8")).toBe("malformed config must still be backed up");
  });

  it("refuses a continuously live owner within the existing readiness budget", async () => {
    let clock = 0;
    await expect(
      waitForOpenClawGatewayOwner(runtime("return { pid: 123 };"), {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/maintenance budget/);
    expect(clock).toBe(120_000);
  });

  it.each(['throw new Error("unreadable lock");', "return null;", 'return { pid: "invalid" };'])(
    "refuses unverifiable native inspection without retry (%s)",
    async (body) => {
      const wait = vi.fn();
      await expect(waitForOpenClawGatewayOwner(runtime(body), { sleep: wait })).rejects.toThrow();
      expect(wait).not.toHaveBeenCalled();
    },
  );
});

describe("empty Telegram thread-binding restoration", () => {
  function source(raw: string) {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "empty-telegram-"));
    roots.push(state);
    const directory = path.join(state, "telegram");
    fs.mkdirSync(directory);
    const file = path.join(directory, "thread-bindings-default.json");
    fs.writeFileSync(file, raw);
    return { state, directory, file };
  }

  it.each(['{"version":1,"bindings":[]}\n', ' { "bindings" : [ ], "version" : 1 } '])(
    "preserves exact empty source bytes in an archive (%s)",
    (raw) => {
      const proof = source(raw);
      fs.writeFileSync(`${proof.file}.migrated`, "existing archive");
      archiveEmptyTelegramThreadBindings(proof.state);
      expect(fs.existsSync(proof.file)).toBe(false);
      const archives = fs
        .readdirSync(proof.directory)
        .filter((name) => name.startsWith(".nemoclaw-"));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toMatch(/\.migrated$/);
      expect(
        fs.readFileSync(
          path.join(proof.directory, archives[0]!, path.basename(proof.file)),
          "utf8",
        ),
      ).toBe(raw);
      expect(fs.readFileSync(`${proof.file}.migrated`, "utf8")).toBe("existing archive");
      expect(() => archiveEmptyTelegramThreadBindings(proof.state)).not.toThrow();
    },
  );

  it.each([
    '{"version":1,"bindings":[{"chatId":"123"}]}',
    '{"version":1,"bindings":[],"metadata":{}}',
    '{"version":1,"bindings":[{"chatId":"123"}],"bindings":[]}',
    '{"version":1,"bindings":[{"chatId":"123"}],"\\u0062indings":[]}',
    '{"version":1,"bindings":[]}\u00a0',
    '{"version":2,"bindings":[]}',
    "invalid JSON",
  ])("leaves uncertain source bytes for the retirement detector (%s)", (raw) => {
    const proof = source(raw);
    archiveEmptyTelegramThreadBindings(proof.state);
    expect(fs.readFileSync(proof.file, "utf8")).toBe(raw);
    expect(fs.readdirSync(proof.directory)).toEqual([path.basename(proof.file)]);
  });

  it.each([
    ["symbolic", fs.symlinkSync],
    ["hard", fs.linkSync],
  ] as const)("preserves a %s link without archiving", (_kind, link) => {
    const proof = source('{"version":1,"bindings":[]}');
    const other = path.join(proof.state, "original.json");
    fs.renameSync(proof.file, other);
    link(other, proof.file);
    archiveEmptyTelegramThreadBindings(proof.state);
    expect(fs.readFileSync(proof.file)).toEqual(fs.readFileSync(other));
    expect(fs.readdirSync(proof.directory)).toEqual([path.basename(proof.file)]);
  });

  it("refuses a linked Telegram directory", () => {
    const proof = source('{"version":1,"bindings":[]}');
    const other = path.join(proof.state, "elsewhere");
    fs.renameSync(proof.directory, other);
    fs.symlinkSync(other, proof.directory);
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow();
    expect(fs.existsSync(proof.file)).toBe(true);
  });

  it("preserves a source replaced during archival and blocks the next attempt", () => {
    const proof = source('{"version":1,"bindings":[]}');
    const originalRename = fs.renameSync;
    const replaced = '{"version":1,"bindings":[{"chatId":"123"}]}';
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      expect(from).toBe(proof.file);
      originalRename(from, `${proof.file}.original`);
      fs.writeFileSync(proof.file, replaced);
      originalRename(from, to);
    });
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow(
      /changed during archival/,
    );
    const pending = fs.readdirSync(proof.directory).find((name) => name.startsWith(".nemoclaw-"))!;
    expect(
      fs.readFileSync(path.join(proof.directory, pending, path.basename(proof.file)), "utf8"),
    ).toBe(replaced);
    expect(fs.readFileSync(`${proof.file}.original`, "utf8")).toBe('{"version":1,"bindings":[]}');
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow(/Incomplete/);
  });

  it("retains a pending archive replaced with a symlink before verification", () => {
    const proof = source('{"version":1,"bindings":[]}');
    const outside = path.join(proof.state, "outside.json");
    fs.writeFileSync(outside, "outside-state");
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      originalRename(from, to);
      originalRename(to, `${String(to)}.original`);
      fs.symlinkSync(outside, to);
    });
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow();
    const pending = fs.readdirSync(proof.directory).find((name) => name.startsWith(".nemoclaw-"))!;
    expect(pending).not.toMatch(/\.migrated$/);
    expect(fs.readlinkSync(path.join(proof.directory, pending, path.basename(proof.file)))).toBe(
      outside,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-state");
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow(/Incomplete/);
  });

  it("retains a pending archive when its pathname changes after descriptor validation", () => {
    const proof = source('{"version":1,"bindings":[]}');
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync")
      .mockImplementationOnce(originalRead)
      .mockImplementationOnce((file, ...args) => {
        expect(typeof file).toBe("number");
        const bytes = originalRead(file, ...args);
        const pending = fs
          .readdirSync(proof.directory)
          .find((name) => name.startsWith(".nemoclaw-"))!;
        const archived = path.join(proof.directory, pending, path.basename(proof.file));
        fs.renameSync(archived, `${archived}.original`);
        fs.writeFileSync(archived, "replacement-state");
        return bytes;
      });
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow(/archive changed/);
    const pending = fs.readdirSync(proof.directory).find((name) => name.startsWith(".nemoclaw-"))!;
    expect(pending).not.toMatch(/\.migrated$/);
    expect(
      fs.readFileSync(path.join(proof.directory, pending, path.basename(proof.file)), "utf8"),
    ).toBe("replacement-state");
    expect(() => archiveEmptyTelegramThreadBindings(proof.state)).toThrow(/Incomplete/);
  });
});

function fixture(
  options: { writer?: string; stateSchema?: number; agentSchema?: number; scenario?: string } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migrations-"));
  roots.push(home);
  const state = path.join(home, ".openclaw");
  fs.mkdirSync(state);
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      meta: { lastTouchedVersion: options.writer ?? "2026.9.2" },
      retained: "fixture-secret-value",
    }),
  );
  const calls = path.join(home, "calls.jsonl");
  const preflights = path.join(home, "preflights.jsonl");
  const target = path.join(home, "target");
  const migrationRoot = path.join(home, "bridges");
  const io = `import fs from 'node:fs';
    function createConfigIO() { return { readConfigFileSnapshot() { return {exists:true,sourceConfig:JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'))}; } }; }
    export { createConfigIO };`;
  const write = (root: string, name: string, body: string) =>
    fs.writeFileSync(path.join(root, "dist", name), body);
  const runtime = (root: string, version: string) => {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module", version }),
    );
    write(root, "io-fixture.mjs", io);
  };
  runtime(target, "2026.10.5");
  write(
    target,
    "openclaw-state-db.paths-fixture.mjs",
    `function resolveOpenClawStateSqlitePath(){return process.env.OPENCLAW_STATE_DIR+'/state/openclaw.sqlite';} export {resolveOpenClawStateSqlitePath};`,
  );
  write(
    target,
    "sqlite-snapshot-source-fixture.mjs",
    `import fs from 'node:fs';
    function prepareSqliteReadOnlyLocation(source,options){
      if(options.preserveSourceArtifacts!==true||options.allowLiveOwner!==false)throw new Error('unsafe inspection');
      const location=source+'.inspection';fs.copyFileSync(source,location);
      return {location,cleanup(){fs.unlinkSync(location);return true;}};
    } export {prepareSqliteReadOnlyLocation};`,
  );
  write(
    target,
    "agent-scope-config-fixture.mjs",
    `function listAgentIds(){return ['main'];} function resolveAgentDir(){return process.env.OPENCLAW_STATE_DIR+'/agents/main/agent';} export {listAgentIds,resolveAgentDir};`,
  );
  write(
    target,
    "targets-fixture.mjs",
    `function resolveConfiguredAgentDatabaseCandidatePaths(){return [process.env.OPENCLAW_STATE_DIR+'/custom/openclaw-agent.sqlite'];} export {resolveConfiguredAgentDatabaseCandidatePaths};`,
  );
  write(
    target,
    "openclaw-database-preflight-fixture.mjs",
    `import fs from 'node:fs';
    function preflightOpenClawDatabaseSchemas(options){
      fs.appendFileSync(process.env.FIXTURE_PREFLIGHTS,JSON.stringify(options)+'\\n');
      if(process.env.FIXTURE_SCENARIO==='unreadable')return {incompatible:[],indeterminate:[{reason:'fixture-secret-value'}]};
      if(process.env.FIXTURE_SCENARIO==='malformed')return {incompatible:[]};
      const incompatible=[];
      if(Number(process.env.FIXTURE_STATE_SCHEMA)>options.supportedVersions.state)incompatible.push({kind:'state'});
      if(Number(process.env.FIXTURE_AGENT_SCHEMA)>options.supportedVersions.agent)incompatible.push({kind:'agent'});
      return {incompatible,indeterminate:[]};
    } export {preflightOpenClawDatabaseSchemas};`,
  );
  for (const version of ["2026.9.5", "2026.9.7"]) {
    const root = path.join(migrationRoot, version, "node_modules", "openclaw");
    runtime(root, version);
    write(
      root,
      "paths-fixture.mjs",
      `function resolveStateDir(){return process.env.OPENCLAW_STATE_DIR;} export {resolveStateDir};`,
    );
    write(
      root,
      "openclaw-agent-db-registry-listing-fixture.mjs",
      `import assert from 'node:assert/strict';
      const registrations=[{agentId:'main',path:process.env.OPENCLAW_STATE_DIR+'/openclaw-agent.sqlite',schemaVersion:17}];
      function inspectOpenClawRegisteredAgentDatabases(options){
        assert.equal(options.env,process.env);assert.equal(options.includeIncompatibleSchemaVersions,true);
        return registrations;
      }
      export {inspectOpenClawRegisteredAgentDatabases,registrations};`,
    );
    write(
      root,
      "sqlite-readonly-worker-fixture.mjs",
      `import assert from 'node:assert/strict';
      async function withSqliteReadOnlyWorkerScope(operation,options){assert.equal(options.signal.aborted,false);return await operation();}
      export {withSqliteReadOnlyWorkerScope};`,
    );
    write(
      root,
      "targets-fixture.mjs",
      `import assert from 'node:assert/strict';
      import {registrations} from './openclaw-agent-db-registry-listing-fixture.mjs';
      function resolveAllAgentSessionStoreCandidateTargetsSync(config,options){assert.equal(options.registeredDatabases,registrations);return [{agentId:'main',storePath:process.env.OPENCLAW_STATE_DIR+'/sessions.json'}];}
      function resolveSessionStoreTargets(config,selection,options){assert.equal(selection.allAgents,true);return resolveAllAgentSessionStoreCandidateTargetsSync(config,options);}
      export {resolveAllAgentSessionStoreCandidateTargetsSync,resolveSessionStoreTargets};`,
    );
    write(
      root,
      "session-sqlite-target-fixture.mjs",
      `import assert from 'node:assert/strict';
      import {registrations} from './openclaw-agent-db-registry-listing-fixture.mjs';
      function resolveSqliteTargetFromSessionStorePath(storePath,options){
        assert.equal(options.registeredDatabases,registrations);assert.equal(options.env,process.env);assert.equal(options.agentId,'main');
        return {path:storePath.endsWith('.sqlite')?storePath:process.env.OPENCLAW_STATE_DIR+'/openclaw-agent.sqlite'};
      }
      export {resolveSqliteTargetFromSessionStorePath};`,
    );
    fs.mkdirSync(path.join(root, "dist/extensions/telegram"), { recursive: true });
    write(
      root,
      "extensions/telegram/doctor-contract-api.js",
      `const stateMigrations=[{id:'telegram-legacy-state',detectLegacyState(){return process.env.FIXTURE_SCENARIO==='retired-remains'?{preview:['unmigrated source']}:null;}}]; export {stateMigrations};`,
    );
    write(
      root,
      "legacy.roster-fixture.mjs",
      `function migratePersistedImplicitMainRoster(config){return {config};} export {migratePersistedImplicitMainRoster};`,
    );
    write(
      root,
      version === "2026.9.5" ? "io.snapshot-fixture.mjs" : "config-flow-steps-fixture.mjs",
      `function applyLegacyDoctorMigrations(config,options){if(options.pluginContracts!==false)throw new Error('plugin execution was enabled');return {next:config};} export {applyLegacyDoctorMigrations as x};`,
    );
    write(
      root,
      "validation-core-fixture.mjs",
      `function validateConfigObjectRaw(){if(process.env.FIXTURE_SCENARIO==='preview-error')throw new Error('fixture-secret-value');return {ok:process.env.FIXTURE_SCENARIO!=='unknown-config'};} export {validateConfigObjectRaw};`,
    );
    fs.writeFileSync(
      path.join(root, "openclaw.mjs"),
      `import fs from 'node:fs';
      const version=${JSON.stringify(version)};
      if(version==='2026.9.7'&&process.env.FIXTURE_SCENARIO==='empty-thread'&&fs.existsSync(process.env.OPENCLAW_STATE_DIR+'/telegram/thread-bindings-default.json'))process.exit(1);
      const prior=fs.existsSync(process.env.FIXTURE_CALLS)?fs.readFileSync(process.env.FIXTURE_CALLS,'utf8').trim().split('\\n').filter(Boolean):[];
      fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({version,args:process.argv.slice(2)})+'\\n');
      const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
      config.meta.lastTouchedVersion=process.env.FIXTURE_SCENARIO==='changed-during-pass'?'2026.10.5':version;
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config));
      if(prior.length===0&&process.env.FIXTURE_SCENARIO==='first-pass-failure')process.exitCode=1;`,
    );
  }
  const before = fs.readFileSync(configPath);
  return {
    state,
    target,
    migrationRoot,
    configPath,
    before,
    calls: () =>
      fs.existsSync(calls)
        ? fs
            .readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    preflights: () =>
      fs.existsSync(preflights)
        ? fs
            .readFileSync(preflights, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    run: () =>
      spawnSync(process.execPath, [script, "--run", target, migrationRoot], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath,
          FIXTURE_CALLS: calls,
          FIXTURE_PREFLIGHTS: preflights,
          FIXTURE_STATE_SCHEMA: String(options.stateSchema ?? 15),
          FIXTURE_AGENT_SCHEMA: String(options.agentSchema ?? 20),
          FIXTURE_SCENARIO: options.scenario ?? "",
        },
      }),
  };
}

describe("OpenClaw intermediate restore migrations", () => {
  it.each([
    { entries: "{}", populated: true, admitted: true, status: 0 },
    { entries: '{"legacy":{"sessionId":"old"}}', populated: false, admitted: true, status: 0 },
    { entries: '{"legacy":{"sessionId":"old"}}', populated: true, admitted: false, status: 42 },
    {
      entries: '{"legacy":{"sessionId":"old"}}',
      populated: true,
      admitted: false,
      status: 42,
      shared: true,
    },
    { entries: "[]", populated: true, admitted: false, status: 1 },
    { entries: "{", populated: true, admitted: false, status: 1 },
  ])("preserves both session stores before bridge writes (%j)", (scenario) => {
    const proof = fixture();
    const source = path.join(
      proof.state,
      scenario.shared ? "sessions/sessions.json" : "sessions.json",
    );
    const sqlite = path.join(proof.state, "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, scenario.entries);
    const db = new DatabaseSync(sqlite);
    db.exec(
      "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT)",
    );
    db.prepare("INSERT INTO session_nodes SELECT ?, ?, ? WHERE ?").run(
      "agent:main:current",
      "new",
      '{"label":"current-metadata"}',
      Number(scenario.populated),
    );
    db.close();
    const before = fs.readFileSync(sqlite);
    const result = proof.run();
    expect(result.status, result.stderr).toBe(scenario.status);
    expect(
      result.stderr.includes("Legacy session JSON and populated SQLite sessions coexist"),
    ).toBe(scenario.status === 42);
    expect(result.stderr.includes("OpenClaw 2026.9.5 session preservation failed")).toBe(
      scenario.status === 1,
    );
    expect(result.stderr).not.toContain(source);
    expect(result.stderr).not.toContain(sqlite);
    expect(proof.calls()).toHaveLength(scenario.admitted ? 4 : 0);
    expect(fs.readFileSync(sqlite)).toEqual(before);
    expect(fs.readFileSync(source, "utf8")).toBe(scenario.entries);
    expect(fs.existsSync(`${sqlite}.inspection`)).toBe(false);
  });

  it.each([
    ["install_records_json", "{"],
    ["install_records_json", "[]"],
    ["plugins_json", "{}"],
    ["diagnostics_json", "{"],
    ["index_key", "unrecognized-ledger"],
    ["plugins_json", "[]"],
  ])("preserves legacy plugin state before bridge writes (%s=%s)", (column, value) => {
    const proof = fixture();
    const directory = path.join(proof.state, "state");
    fs.mkdirSync(directory);
    const file = path.join(directory, "openclaw.sqlite");
    const db = new DatabaseSync(file);
    const row = {
      index_key: "installed-plugin-index",
      install_records_json: '{"demo":{"source":"npm","spec":"demo@1.0.0"}}',
      plugins_json: "[]",
      diagnostics_json: "[]",
      [column]: value,
    };
    db.exec(
      "CREATE TABLE installed_plugin_index (index_key TEXT, install_records_json TEXT, plugins_json TEXT, diagnostics_json TEXT)",
    );
    db.prepare("INSERT INTO installed_plugin_index VALUES (?, ?, ?, ?)").run(
      row.index_key,
      row.install_records_json,
      row.plugins_json,
      row.diagnostics_json,
    );
    db.close();
    const before = fs.readFileSync(file);
    const result = proof.run();
    const valid = column === "plugins_json" && value === "[]";
    expect(result.status, result.stderr).toBe(valid ? 0 : 1);
    expect(proof.calls()).toHaveLength(valid ? 4 : 0);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(directory)).toEqual(["openclaw.sqlite"]);
    const expectedConfig = valid
      ? Buffer.from(proof.before.toString().replace('"2026.9.2"', '"2026.9.7"'))
      : proof.before;
    expect(fs.readFileSync(proof.configPath)).toEqual(expectedConfig);
  });

  it("archives verified empty Telegram state before the 9.7 Doctor can refuse it", () => {
    const proof = fixture({ scenario: "empty-thread" });
    fs.mkdirSync(path.join(proof.state, "telegram"));
    fs.writeFileSync(
      path.join(proof.state, "telegram/thread-bindings-default.json"),
      '{"version":1,"bindings":[]}',
    );
    const result = proof.run();
    expect(result.status, result.stderr).toBe(0);
    expect(proof.calls().map((call) => call.version)).toEqual([
      "2026.9.5",
      "2026.9.5",
      "2026.9.7",
      "2026.9.7",
    ]);
  });
  it.each(["", "first-pass-failure"])(
    "runs the reviewed sequence with one dependent migration pass (%s)",
    (scenario) => {
      const proof = fixture({ scenario });
      const result = proof.run();
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(proof.calls().map((call) => call.version)).toEqual([
        "2026.9.5",
        "2026.9.5",
        "2026.9.7",
        "2026.9.7",
      ]);
      expect(proof.calls().map((call) => call.args)).toEqual(
        Array(4).fill(["doctor", "--fix", "--yes", "--non-interactive"]),
      );
      expect(
        proof.preflights().map((inspected) => ({
          preserveSourceArtifacts: inspected.preserveSourceArtifacts,
          targetCount: inspected.configuredAgentDatabaseTargets.length,
          candidateCount: inspected.configuredAgentDatabaseCandidatePaths.length,
        })),
      ).toEqual(
        Array(4).fill({ preserveSourceArtifacts: true, targetCount: 1, candidateCount: 1 }),
      );
    },
  );
  it.each([{ stateSchema: 18 }, { agentSchema: 24 }, { writer: "2026.9.6" }])(
    "skips an intermediate runtime incompatible with source state %j",
    (options) => {
      const proof = fixture(options);
      expect(proof.run().status).toBe(0);
      expect(proof.calls().map((call) => call.version)).toEqual(["2026.9.7", "2026.9.7"]);
    },
  );
  it.each([{ stateSchema: 20 }, { agentSchema: 25 }, { writer: "2026.10.5" }])(
    "leaves current state for the target Doctor %j",
    (options) => {
      const proof = fixture(options);
      expect(proof.run().status).toBe(0);
      expect(proof.calls()).toEqual([]);
      expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
    },
  );
  it.each(["unreadable", "malformed", "unknown-config", "preview-error"])(
    "refuses uncertain compatibility before invoking a Doctor (%s)",
    (scenario) => {
      const proof = fixture({ scenario });
      const result = proof.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("fixture-secret-value");
      expect(result.stderr).not.toContain(proof.configPath);
      expect(result.stderr).not.toContain(proof.target);
      expect(result.stderr).toContain(
        `OpenClaw 2026.9.5 ${scenario === "unknown-config" || scenario === "preview-error" ? "config preview" : "schema admission"} failed; native details withheld`,
      );
      expect(proof.calls()).toEqual([]);
      expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
    },
  );
  it("refuses a second pass if another writer upgraded state", () => {
    const proof = fixture({ scenario: "changed-during-pass" });
    expect(proof.run().status).not.toBe(0);
    expect(proof.calls()).toHaveLength(1);
  });
  it.each([
    ["io-fixture.mjs", "return {exists:true", "source config read"],
    ["io.snapshot-fixture.mjs", "", "native migration export loading"],
    ["legacy.roster-fixture.mjs", "return {config}", "agent roster normalization"],
    ["io.snapshot-fixture.mjs", "return {next:config}", "core config migration"],
    ["validation-core-fixture.mjs", "return {ok:", "config validation"],
    ["targets-fixture.mjs", "return [{agentId:", "session candidate discovery"],
  ])(
    "identifies a failed preview without exposing native input (%s, %s)",
    (file, needle, stage) => {
      const proof = fixture();
      const modulePath = path.join(
        proof.migrationRoot,
        "2026.9.5/node_modules/openclaw/dist",
        file,
      );
      const original = fs.readFileSync(modulePath, "utf8");
      const rejection = `throw new Error(${JSON.stringify(`fixture-secret-value ${proof.configPath}`)});`;
      expect(original).toContain(needle);
      fs.writeFileSync(
        modulePath,
        needle ? original.replace(needle, rejection + needle) : rejection + original,
      );
      const result = proof.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Preview stage: ${stage}.`);
      expect(result.stderr).not.toContain("fixture-secret-value");
      expect(result.stderr).not.toContain(proof.configPath);
      expect(result.stderr).not.toContain(modulePath);
      expect(proof.calls()).toEqual([]);
      expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
    },
  );
  describe.each(["2026.9.5", "2026.9.7"])("session inventory diagnostics for %s", (version) => {
    it.each([
      [
        "targets-fixture.mjs",
        "resolveAllAgentSessionStoreCandidateTargetsSync,",
        "",
        "session candidate export loading",
      ],
      [
        "targets-fixture.mjs",
        ",resolveSessionStoreTargets};",
        "};",
        "configured session export loading",
      ],
      [
        "sqlite",
        "export {resolveSqliteTargetFromSessionStorePath};",
        "",
        "session SQLite export loading",
      ],
      [
        "openclaw-agent-db-registry-listing-fixture.mjs",
        "inspectOpenClawRegisteredAgentDatabases,registrations};",
        "registrations};",
        "session registry export loading",
      ],
      [
        "openclaw-agent-db-registry-listing-fixture.mjs",
        "return registrations;",
        "REJECT;",
        "session registry inspection",
      ],
      [
        "sqlite-readonly-worker-fixture.mjs",
        "return await operation();",
        "REJECT;",
        "session registry inspection",
      ],
      [
        "openclaw-agent-db-registry-listing-fixture.mjs",
        "return registrations;",
        "return undefined;",
        "session registry inspection",
      ],
      [
        "paths-fixture.mjs",
        "export {resolveStateDir};",
        "if(process.argv[2]==='--preview')resolveStateDir=undefined;export {resolveStateDir};",
        "session state-directory export loading",
      ],
      [
        "targets-fixture.mjs",
        "return [{agentId:",
        "REJECT;return [{agentId:",
        "session candidate discovery",
      ],
      [
        "targets-fixture.mjs",
        "return resolveAllAgentSessionStoreCandidateTargetsSync(config,options);",
        "REJECT;",
        "configured session discovery",
      ],
      [
        "paths-fixture.mjs",
        "return process.env.OPENCLAW_STATE_DIR;",
        "if(process.argv[2]==='--preview'){REJECT;}return process.env.OPENCLAW_STATE_DIR;",
        "session state-directory resolution",
      ],
      [
        "targets-fixture.mjs",
        "return resolveAllAgentSessionStoreCandidateTargetsSync(config,options);",
        "return undefined;",
        "session inventory result validation",
      ],
      [
        "sqlite",
        "return {path:storePath",
        "REJECT;return {path:storePath",
        "configured session SQLite path resolution",
      ],
      [
        "sqlite",
        "return {path:storePath",
        "resolveSqliteTargetFromSessionStorePath.calls=(resolveSqliteTargetFromSessionStorePath.calls??0)+1;if(resolveSqliteTargetFromSessionStorePath.calls===2){REJECT;}return {path:storePath",
        "candidate session SQLite path resolution",
      ],
    ])(
      "refuses before Doctor and retains private inputs (%s, %s)",
      (file, needle, replacement, stage) => {
        const proof = fixture({ writer: version === "2026.9.7" ? "2026.9.6" : "2026.6.10" });
        const modulePath = path.join(
          proof.migrationRoot,
          version,
          "node_modules/openclaw/dist",
          file === "sqlite" ? "session-sqlite-target-fixture.mjs" : file,
        );
        const original = fs.readFileSync(modulePath, "utf8");
        const rejection = `throw new Error(${JSON.stringify(`fixture-secret-value ${proof.configPath}`)})`;
        expect(original).toContain(needle);
        fs.writeFileSync(
          modulePath,
          original.replace(needle, replacement.replace("REJECT", rejection)),
        );
        const result = proof.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`OpenClaw ${version} config preview failed`);
        expect(result.stderr).toContain(`Preview stage: ${stage}.`);
        expect(result.stderr).not.toContain("fixture-secret-value");
        expect(result.stderr).not.toContain(proof.configPath);
        expect(result.stderr).not.toContain(modulePath);
        expect(proof.calls()).toEqual([]);
        expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
      },
    );
  });
  it("refuses stranded Telegram state even when both older runtimes were skipped", () => {
    const proof = fixture({ writer: "2026.10.5", scenario: "retired-remains" });
    const result = proof.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OpenClaw 2026.9.7 retired Telegram state inspection failed");
    expect(result.stderr).not.toContain("unmigrated source");
    expect(proof.calls()).toEqual([]);
    expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
  });
  it.each([
    {
      sourceRemains: false,
      prepareSource: (_source: string, _bytes: string) => {},
      verifySource: (source: string, _bytes: string) => expect(fs.existsSync(source)).toBe(false),
    },
    {
      sourceRemains: true,
      prepareSource: (source: string, bytes: string) => fs.writeFileSync(source, bytes),
      verifySource: (source: string, bytes: string) =>
        expect(fs.readFileSync(source, "utf8")).toBe(bytes),
    },
  ])(
    "reports retained incomplete Telegram archival on every retry (source remains: $sourceRemains)",
    ({ sourceRemains, prepareSource, verifySource }) => {
      const proof = fixture({ writer: "2026.9.6" });
      const directory = path.join(proof.state, "telegram");
      const pending = path.join(directory, ".nemoclaw-telegram-empty-fixture-secret-value");
      fs.mkdirSync(pending, { recursive: true });
      const retained = path.join(pending, "thread-bindings-private.json");
      const bytes = '{"version":1,"bindings":[{"chatId":"retained-telegram-secret"}]}';
      fs.writeFileSync(retained, bytes);
      const source = path.join(directory, "thread-bindings-default.json");
      prepareSource(source, bytes);
      const entries = fs.readdirSync(directory).sort();
      const verifyAttempt = () => {
        const result = proof.run();
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(43);
        expect(result.stderr).toContain("Incomplete Telegram archival");
        expect(result.stderr).toContain("telegram/.nemoclaw-telegram-empty-*");
        expect(result.stderr).toContain("without a .migrated suffix");
        expect(result.stderr).toContain("Restore a consistent backup before retrying");
        expect(result.stderr).toContain("gateway remains stopped");
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("fixture-secret-value");
        expect(result.stderr).not.toContain("retained-telegram-secret");
        expect(result.stderr).not.toContain(proof.state);
        expect(proof.calls()).toEqual([]);
        expect(fs.readFileSync(proof.configPath)).toEqual(proof.before);
        expect(fs.readFileSync(retained, "utf8")).toBe(bytes);
        expect(fs.readdirSync(directory).sort()).toEqual(entries);
        expect(fs.existsSync(source)).toBe(sourceRemains);
        verifySource(source, bytes);
      };
      verifyAttempt();
      verifyAttempt();
    },
  );
  it("refuses a missing or drifted intermediate runtime before Doctor", () => {
    const proof = fixture();
    fs.writeFileSync(
      path.join(proof.migrationRoot, "2026.9.5/node_modules/openclaw/package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.6" }),
    );
    const result = proof.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Preview stage: runtime identity.");
    expect(proof.calls()).toEqual([]);
  });
});
