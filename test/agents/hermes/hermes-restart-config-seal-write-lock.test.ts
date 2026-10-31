// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  RUNTIME_CONFIG_GUARD,
  runGuard,
  runWriteConfig,
  strictHashIsValid,
  writeMutationLock,
} from "../../helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
  it("atomically binds a host config write to the bytes that were read and refreshes both hashes", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const updatedConfig = "model:\n  default: trusted-model-v2\n";

    try {
      const updated = runWriteConfig(fixture, expectedDigest, updatedConfig);

      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(updatedConfig);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts exactly 16 MiB at the size guard before validating filesystem state", () => {
    const fixture = createRestartFixture();
    const configAtLimit = "a".repeat(16 * 1024 * 1024);
    fs.rmSync(fixture.root, { recursive: true, force: true });

    const updated = runWriteConfig(fixture, "0".repeat(64), configAtLimit);

    expect(updated.status).not.toBe(0);
    expect(updated.stderr).not.toContain("refusing oversized Hermes config input");
    expect(updated.stderr).toContain("No such file or directory");
  });

  it("rejects Hermes configuration input larger than 16 MiB without creating restart state", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const oversizedConfig = "a".repeat(16 * 1024 * 1024 + 1);

    try {
      const updated = runWriteConfig(fixture, expectedDigest, oversizedConfig);

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("refusing oversized Hermes config input");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to launder a stale host read and leaves the trusted config unchanged", () => {
    const fixture = createRestartFixture();
    const staleDigest = createHash("sha256").update("attacker-controlled read\n").digest("hex");

    try {
      const updated = runWriteConfig(
        fixture,
        staleDigest,
        "model:\n  default: attacker-derived-model\n",
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config changed after the host read");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes restart sealing against a host-held config mutation lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o770);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a dead mutation lock published before seal state creation", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    try {
      const lockPath = writeMutationLock(fixture, token);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      const recovered = spawnSync(
        "python3",
        [
          RUNTIME_CONFIG_GUARD,
          "recover-prestate-lock",
          "--hermes-dir",
          fixture.hermesDir,
          "--state-file",
          fixture.statePath,
          "--startup-owner",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout.trim()).toBe("recovered=1");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a host config transaction while another Hermes mutation owns the lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: should-not-commit\n",
      );
      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back a config-write phase killed after rename but before strict hash refresh", () => {
    const fixture = createRestartFixture();

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      state.phase = "config-write-prepared";
      state.config_write = {
        original_base64: Buffer.from(fixture.trustedConfig).toString("base64"),
        original_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
      };
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(fixture.statePath, 0o600);

      const replacement = path.join(fixture.hermesDir, ".config.crash-test");
      fs.writeFileSync(replacement, "model:\n  default: interrupted-write\n", { mode: 0o444 });
      fs.chmodSync(replacement, 0o444);
      fs.renameSync(replacement, fixture.configPath);
      expect(strictHashIsValid(fixture)).toBe(false);

      const recovered = runGuard("unseal-restart", fixture);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

// The schema stub matches the existing restart-seal host fixture. All filesystem,
// exact-digest, source-adoption, secret-boundary and rollback operations are real.
describe.skipIf(process.platform === "win32")(
  "Hermes restored native credential transaction",
  () => {
    it.each(["local", "nvidia"])(
      "bounds restored %s adoption and preserves denials and recovery fences",
      (provider) => {
        const result = spawnSync(
          "python3",
          [
            "-I",
            "-c",
            String.raw`
import copy, hashlib, importlib.util, json, os, pathlib, sys, tempfile, types
source=pathlib.Path(sys.argv[1]).resolve()
spec=importlib.util.spec_from_file_location('hermes_guard',source)
guard=importlib.util.module_from_spec(spec);sys.modules[spec.name]=guard;spec.loader.exec_module(guard)
# Same narrow schema seam as repository restart-seal fixture; filesystem/hash/seal/write are real.
class GatewayConfig:
 @classmethod
 def from_dict(cls,value):
  if not isinstance(value,dict): raise TypeError('mapping required')
  return cls()
sys.modules['gateway.config']=types.SimpleNamespace(GatewayConfig=GatewayConfig)
# Model an admitted managed nonroot topology; do not alter any hash/digest/path/race predicates.
guard._managed_nonroot_reconciliation_is_allowed=lambda:True
nvidia = sys.argv[2] == 'nvidia'


def sha(b):return hashlib.sha256(b).hexdigest()
def run(case):
 with tempfile.TemporaryDirectory(prefix='hermes-restored-') as t:
  r=pathlib.Path(t);s=r/'sandbox';h=s/'.hermes';h.mkdir(parents=True)
  os.chmod(s,0o770);os.chmod(h,0o700)
  config=h/'config.yaml';env=h/'.env';compat=h/'.config-hash';strict=r/'strict';state=r/'state.json'
  def body(ref):
   return guard.yaml.safe_dump({'_nemoclaw_upstream':{'provider':'compatible-endpoint','provider_key':'compatible-endpoint','model':'m'},'model':{'default':'m','provider':'custom','base_url':'http://host.openshell.internal:8000/v1','api_key':ref},'providers':{'compatible-endpoint':{'api':'http://host.openshell.internal:8000/v1','api_key':ref,'default_model':'m'}},'custom_providers':[{'name':'compatible-endpoint','base_url':'http://host.openshell.internal:8000/v1','api_key':ref}],'mcp_servers':{}},sort_keys=False).encode()
  local_body=body
  def body(ref):
   data=local_body(ref)
   return data.replace(b'compatible-endpoint',b'nvidia-prod').replace(b'http://host.openshell.internal:8000/v1',b'https://integrate.api.nvidia.com/v1').replace(b'NEMOCLAW_LOCAL_INFERENCE_TOKEN',b'NVIDIA_INFERENCE_API_KEY') if nvidia and not case.startswith('registered-') else data
  old=body('openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN');fresh=body('openshell:resolve:env:v8_NEMOCLAW_LOCAL_INFERENCE_TOKEN')
  if case.startswith('registered-'):
   old=old.replace(b'compatible-endpoint',b'operator-provider').replace(b'NEMOCLAW_LOCAL_INFERENCE_TOKEN',b'VENDOR_API_KEY')
   fresh=fresh.replace(b'compatible-endpoint',b'operator-provider').replace(b'NEMOCLAW_LOCAL_INFERENCE_TOKEN',b'VENDOR_API_KEY')
  if case=='registered-env-change':fresh=fresh.replace(b'VENDOR_API_KEY',b'OTHER_KEY')
  if case=='registered-raw-source':old=old.replace(b'openshell:resolve:env:v7_VENDOR_API_KEY',b'raw-secret')
  if case=='registered-placeholder-source':old=old.replace(b'openshell:resolve:env:v7_VENDOR_API_KEY',b'$'+b'{VENDOR_API_KEY}')
  if case=='registered-route-drift':fresh=fresh.replace(b'host.openshell.internal',b'changed.example')

  oldenv=b'SAFE_SETTING=trusted\nAPI_SERVER_KEY='+b'a'*64+b'\n';freshenv=b'SAFE_SETTING=trusted\nAPI_SERVER_KEY='+b'b'*64+b'\n'
  config.write_bytes(old);env.write_bytes(oldenv);os.chmod(config,0o640);os.chmod(env,0o600)
  oldhash=guard._hash_text(str(config),str(env))[0]
  config.write_bytes(fresh);env.write_bytes(freshenv)
  newhash=guard._hash_text(str(config),str(env))[0]
  strict.write_text(newhash);compat.write_text(newhash);os.chmod(strict,0o600);os.chmod(compat,0o600)
  if True:
   config.write_bytes(old);env.write_bytes(b'SAFE_SETTING=trusted\n')
   compat.write_text(oldhash)
  candidate=guard.yaml.safe_load(fresh)
  source_config=guard.yaml.safe_load(old)
  if case=='model-drift':candidate['model']['default']='foreign'
  if case=='route-drift':candidate['model']['base_url']='http://foreign.test:8000/v1'
  if case=='mcp-drift':candidate['mcp_servers']={'unexpected':{}}
  if case=='user-setting-drift':candidate['user_setting']='added'
  if case=='invalid-new-handle':candidate['model']['api_key']='raw-credential'
  if case=='slot-disagreement':source_config['providers']['nvidia-prod' if nvidia else 'compatible-endpoint']['api_key']='openshell:resolve:env:v6_NEMOCLAW_LOCAL_INFERENCE_TOKEN'
  if case=='alias-side-effect':
   source_config['user_model']=source_config['model'];candidate['user_model']=candidate['model']
  config.write_text(guard.yaml.safe_dump(source_config,sort_keys=False))
  fresh=guard.yaml.safe_dump(candidate,sort_keys=False).encode()
  if case=='invalid-schema':fresh=b'[]\n'
  if case=='raw-env':env.write_bytes(b'OPENAI_API_KEY=raw-forbidden\n')
  expected='0'*64 if case=='stale-read' else sha(config.read_bytes())
  paths=[config,env,compat,strict];before={p.name:sha(p.read_bytes()) for p in paths}
  original_write=guard._write_hash
  original_replace=guard._atomic_replace
  if case=='write-failure':
   fail_write=[True]
   def rejected(path,data,**kwargs):
    if path==str(config) and state.exists() and json.loads(state.read_text()).get('phase')=='config-write-prepared' and fail_write[0]:
     fail_write[0]=False
     raise RuntimeError('injected config write failure')
    return original_replace(path,data,**kwargs)
   guard._atomic_replace=rejected
  if case in ['partial-adoption','partial-adoption-source-race']:
   def interrupted(path,text):
    if path==str(strict):raise RuntimeError('injected anchor commit failure')
    return original_write(path,text)
   guard._write_hash=interrupted
  error=None
  try:guard.write_config_transaction(str(h),str(strict),str(state),expected,fresh,restore_native_local_credential=case!='ordinary-write')
  except Exception as e:error=type(e).__name__+': '+str(e)
  finally:guard._write_hash=original_write;guard._atomic_replace=original_replace
  held=state.exists();recovery=None
  if case in ['partial-adoption','partial-adoption-source-race']:
   if case.endswith('source-race'):config.write_bytes(b'model: {default: changed}\n')
   try:guard.unseal_restart(str(h),str(state));recovery='recovered'
   except Exception as e:recovery=type(e).__name__+': '+str(e)
  after={p.name:sha(p.read_bytes()) for p in paths}
  return {'state_held_before_recovery':held,'recovery':recovery,'anchors_match':strict.read_text()==compat.read_text(),'config_source_preserved':sha(config.read_bytes())==before['config.yaml'],'config_candidate_applied':config.read_bytes()==fresh,'case':case,'error':error,'files_unchanged':before==after,'before':before,'after':after,'state_removed':not state.exists(),'lock_removed':not (r/'hermes-config-mutation.lock').exists(),'config_mode':oct(config.stat().st_mode&0o7777),'env_mode':oct(env.stat().st_mode&0o7777)}
cases=['valid-restored','ordinary-write','model-drift','route-drift','mcp-drift','user-setting-drift','invalid-new-handle','slot-disagreement','alias-side-effect','stale-read','raw-env','invalid-schema','write-failure','partial-adoption','partial-adoption-source-race','registered-valid','registered-env-change','registered-raw-source','registered-placeholder-source','registered-route-drift']
rows=[run(x) for x in cases]
print(json.dumps({'source_sha256':sha(source.read_bytes()),'seams':['GatewayConfig fixture schema surface','ordinary-write nonroot topology admission only; restore admission uses real mutable posture'],'cases':rows},indent=2))
assert rows[0]['error'] is None,rows[0]
assert rows[0]['anchors_match'] and rows[0]['state_removed'] and rows[0]['lock_removed']
for row in rows[1:12]:assert row['error'] and row['files_unchanged'] and row['state_removed'] and row['lock_removed'],row
assert rows[13]['state_held_before_recovery'] and rows[13]['recovery']=='recovered' and rows[13]['anchors_match'] and rows[13]['state_removed'],rows[13]
assert rows[14]['state_held_before_recovery'] and not rows[14]['state_removed'] and 'source bytes changed' in rows[14]['recovery'],rows[14]
assert rows[12]['error'] and rows[12]['config_source_preserved'] and rows[12]['anchors_match'] and rows[12]['state_removed'],rows[12]
assert rows[0]['config_candidate_applied']
assert rows[15]['error'] is None and rows[15]['config_candidate_applied'] and rows[15]['state_removed'] and rows[15]['anchors_match'],rows[15]
for row in rows[16:]:assert row['error'] and row['files_unchanged'] and row['state_removed'] and row['lock_removed'],row
`,
            RUNTIME_CONFIG_GUARD,
            provider,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        expect(result.status, result.stderr + result.stdout).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.cases).toHaveLength(20);
        expect(report.cases[0]).toMatchObject({
          error: null,
          config_candidate_applied: true,
          anchors_match: true,
          state_removed: true,
          lock_removed: true,
        });
        expect(report.cases[12]).toMatchObject({
          config_source_preserved: true,
          anchors_match: true,
          state_removed: true,
        });
        expect(report.cases[13]).toMatchObject({ recovery: "recovered", state_removed: true });
        expect(report.cases[14]).toMatchObject({ state_removed: false });
      },
    );
  },
);
