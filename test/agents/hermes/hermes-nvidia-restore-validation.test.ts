// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RUNTIME_CONFIG_GUARD } from "../../helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes NVIDIA restore validation", () => {
  it("accepts only a same-route issued credential replacement", () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import copy, importlib.util, json, os, pathlib, sys, tempfile, types
spec=importlib.util.spec_from_file_location('guard',sys.argv[1])
g=importlib.util.module_from_spec(spec);sys.modules[spec.name]=g;spec.loader.exec_module(g)
class GatewayConfig:
 @classmethod
 def from_dict(cls,value): return cls()
sys.modules['gateway.config']=types.SimpleNamespace(GatewayConfig=GatewayConfig)
with tempfile.TemporaryDirectory() as root:
 h=pathlib.Path(root);cfg=h/'config.yaml';env=h/'.env';strict=h/'strict';compat=h/'.config-hash'
 old='openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY';fresh='openshell:resolve:env:v8_NVIDIA_INFERENCE_API_KEY'
 base={'_nemoclaw_upstream':{'provider':'nvidia-prod','provider_key':'nvidia-prod','model':'m'},'model':{'provider':'custom','default':'m','base_url':'https://integrate.api.nvidia.com/v1','api_key':old},'providers':{'nvidia-prod':{'api':'https://integrate.api.nvidia.com/v1','default_model':'m','api_key':old}},'custom_providers':[{'name':'nvidia-prod','base_url':'https://integrate.api.nvidia.com/v1','api_key':old}],'discord':{'require_mention':True}}
 results={}
 for case in ['valid','template','missing','malformed','wrong-provider','slot-disagreement','model-drift','endpoint-drift','settings-drift']:
  source=copy.deepcopy(base)
  if case=='template':
   source['model']['api_key']='$'+'{NVIDIA_INFERENCE_API_KEY}';source['providers']['nvidia-prod']['api_key']='$'+'{NVIDIA_INFERENCE_API_KEY}';source['custom_providers'][0]['api_key']='$'+'{NVIDIA_INFERENCE_API_KEY}'
  candidate=copy.deepcopy(source)
  candidate['model']['api_key']=fresh;candidate['providers']['nvidia-prod']['api_key']=fresh;candidate['custom_providers'][0]['api_key']=fresh
  if case=='missing':candidate['model'].pop('api_key')
  if case=='malformed':candidate['model']['api_key']='not-a-handle'
  if case=='wrong-provider':candidate['model']['api_key']='openshell:resolve:env:v8_OPENAI_API_KEY'
  if case=='slot-disagreement':candidate['providers']['nvidia-prod']['api_key']=old
  if case=='model-drift':candidate['model']['default']='other'
  if case=='endpoint-drift':candidate['model']['base_url']='https://foreign.example/v1'
  if case=='settings-drift':candidate['discord']['require_mention']=False
  cfg.write_text(g.yaml.safe_dump(source));env.write_text('SAFE_SETTING=preserved\n')
  strict.write_text(g._hash_text(str(cfg),str(env))[0]);compat.write_text(strict.read_text())
  import hashlib
  before=cfg.read_bytes();digest=hashlib.sha256(before).hexdigest()
  try:
   g._adopt_restored_native_local_source(str(h),str(strict),str(h/'unused-state'),digest,g.yaml.safe_dump(candidate).encode(),{},{});results[case]=True
  except g.UnsafePathError as exc:
   assert old not in str(exc) and fresh not in str(exc)
   results[case]=False
  assert cfg.read_bytes()==before
 for label,reference in [('fresh',fresh),('template','$'+'{NVIDIA_INFERENCE_API_KEY}'),('stale',old),('missing',None),('malformed','not-a-handle'),('wrong-provider','openshell:resolve:env:v8_OPENAI_API_KEY')]:
  config=copy.deepcopy(base)
  config['model']['api_key']=reference;config['providers']['nvidia-prod']['api_key']=reference;config['custom_providers'][0]['api_key']=reference
  cfg.write_text(g.yaml.safe_dump(config));before=cfg.read_bytes();os.environ['NVIDIA_INFERENCE_API_KEY']=fresh
  try:g.verify_nvidia_credential(str(h),'m');results['health-'+label]=True
  except g.NvidiaCredentialRejectedError:results['health-'+label]=False
  assert cfg.read_bytes()==before
 # Every slot must agree; a template mixed with issued references is rejected.
 import itertools
 template='$'+'{NVIDIA_INFERENCE_API_KEY}'
 mixed=[slots for slots in itertools.product([fresh,template],repeat=3) if len(set(slots))>1]
 for slots in mixed:
  config=copy.deepcopy(base)
  config['model']['api_key'],config['providers']['nvidia-prod']['api_key'],config['custom_providers'][0]['api_key']=slots
  cfg.write_text(g.yaml.safe_dump(config));os.environ['NVIDIA_INFERENCE_API_KEY']=fresh
  try:g.verify_nvidia_credential(str(h),'m');results.setdefault('health-mixed',[]).append(True)
  except g.NvidiaCredentialRejectedError:results.setdefault('health-mixed',[]).append(False)
 # Exercise the real CLI result protocol; do not expose guard diagnostics to status.
 import subprocess
 for label,reference,supervisor in [('valid',fresh,fresh),('template','$'+'{NVIDIA_INFERENCE_API_KEY}',fresh),('mixed',[template,fresh,fresh],fresh),('stale',old,fresh),('missing-supervisor',fresh,''),('malformed-supervisor',fresh,'bad')]:
  config=copy.deepcopy(base)
  slots=reference if isinstance(reference,list) else [reference]*3
  config['model']['api_key'],config['providers']['nvidia-prod']['api_key'],config['custom_providers'][0]['api_key']=slots
  cfg.write_text(g.yaml.safe_dump(config));before=cfg.read_bytes()
  run=subprocess.run([sys.executable,'-I',sys.argv[1],'verify-nvidia-credential','--hermes-dir',str(h),'--expected-model','m'],env={**os.environ,'NVIDIA_INFERENCE_API_KEY':supervisor},capture_output=True,text=True,timeout=5)
  results['cli-'+label]={'exit':run.returncode,'stdout':run.stdout.strip()}
  assert fresh not in run.stdout+run.stderr and old not in run.stdout+run.stderr
  assert cfg.read_bytes()==before
 # The verifier uses the managed-policy template and handle contract.
 policy=sys.modules['managed_policy']
 results['shared-contract']=g.NVIDIA_INFERENCE_PLACEHOLDER is policy.NVIDIA_INFERENCE_PLACEHOLDER and g.NVIDIA_SCOPED_CREDENTIAL_HANDLE is policy.NVIDIA_SCOPED_CREDENTIAL_HANDLE
 print(json.dumps(results))
`,
        RUNTIME_CONFIG_GUARD,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "cli-valid": { exit: 0, stdout: "verified=1" },
      "cli-template": { exit: 0, stdout: "verified=1" },
      "cli-mixed": { exit: 1, stdout: "rejected=1" },
      "cli-stale": { exit: 1, stdout: "rejected=1" },
      "cli-missing-supervisor": { exit: 1, stdout: "" },
      "cli-malformed-supervisor": { exit: 1, stdout: "" },
      "health-fresh": true,
      "health-template": true,
      "shared-contract": true,
      "health-mixed": [false, false, false, false, false, false],
      "health-stale": false,
      "health-missing": false,
      "health-malformed": false,
      "health-wrong-provider": false,
      valid: true,
      template: true,
      missing: false,
      malformed: false,
      "wrong-provider": false,
      "slot-disagreement": false,
      "model-drift": false,
      "endpoint-drift": false,
      "settings-drift": false,
    });
  });
});
