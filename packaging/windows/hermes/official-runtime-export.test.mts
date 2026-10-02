// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const exporter = fileURLToPath(new URL("./export-official-runtime.py", import.meta.url));
const python = process.env.NEMOCLAW_TEST_PYTHON ?? "python3";
const control = String.raw`
import importlib.util,sys,json,pathlib,tarfile,hashlib,traceback
spec=importlib.util.spec_from_file_location('exporter',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3];inv=m.load_inventory()
build={'schemaVersion':1,'upstreamCommit':inv.UPSTREAM_COMMIT,'status':'runtime-provisioned','installedTier':'hash-verified (uv.lock)','sourceUnchanged':True,'fallbacks':[],'stages':[{'stage':s,'ok':True,'skipped':False} for s in inv.REQUIRED_STAGES]}
build["nodeBuild"]={'schemaVersion': 1, 'profile': 'official-prebuilt-cli-web-tui', 'npmVersion': '12.0.2', 'upstreamLockUnchanged': True, 'neighboringBuildDependenciesAbsent': True, 'tuiNonTtyImports': True, 'desktopSelected': False, 'outputs': [{'path': 'ui-tui/dist'}, {'path': 'hermes_cli/web_dist'}], 'sidecars': [{'path': 'plugins/platforms/photon/sidecar'}, {'path': 'scripts/whatsapp-bridge'}]}
build["selectedBrowserChain"]={'profile': 'official-prebuilt-cli-web-tui', 'browserUse': '0.13.10', 'agentBrowser': 'agent-browser/bin/agent-browser-win32-x64.exe', 'runtimeQualified': False}
try:
 if mode in ('archive','drift','link','root-alias','link-drift','alias-outside'):
  runtime=root/'runtime';runtime.mkdir();(runtime/'empty').mkdir();(runtime/'LICENSE').write_bytes(b'license');(runtime/'dynamic.dat').write_bytes(b'opaque-runtime-bytes');(runtime/'runtime.d.ts').write_text('unpruned');
  if mode in ('link','root-alias','link-drift','alias-outside'):(runtime/'resource-link').symlink_to(runtime/'dynamic.dat')
  lexical_root=str(runtime);canonical_root=str(runtime.resolve())
  if mode in ('root-alias','alias-outside'):
   alias=root/'runtime-alias';alias.symlink_to(runtime,target_is_directory=True);runtime=alias;lexical_root=str(runtime);canonical_root=str(runtime.resolve())
  if mode=='alias-outside':
   (root/'outside').write_bytes(b'outside');(runtime/'resource-link').unlink();(runtime/'resource-link').symlink_to(root/'outside')
  payload=inv.inventory(runtime)
  if mode=='drift':(runtime/'dynamic.dat').write_bytes(b'changed')
  if mode=='link-drift':
   (root/'outside').write_bytes(b'outside');(runtime/'resource-link').unlink();(runtime/'resource-link').symlink_to(root/'outside')
  artifact=root/'candidate.tar.gz';result=m.archive_candidate(runtime,payload,artifact)
  with tarfile.open(artifact) as handle:
   members=[{'name':i.name,'link':i.linkname,'bytes':handle.extractfile(i).read().hex() if i.isfile() else None} for i in handle]
  result.update(members=members,payload=payload,lexicalRoot=lexical_root,canonicalRoot=canonical_root)
 elif mode=='outside-link':
  runtime=root/'runtime';runtime.mkdir();(root/'outside').write_text('not-a-runtime-file');(runtime/'bad').symlink_to(root/'outside');result=inv.inventory(runtime)
 elif mode in ('current-adapter','stale-adapter','modified-adapter'):
  runtime=root/'runtime';runtime.mkdir();runtime=runtime.resolve()
  adapter=pathlib.Path(sys.argv[1]).with_name('nemoclaw_native_windows.py');data=adapter.read_bytes();current=hashlib.sha256(data).hexdigest()
  stale=('0' if current[0]!='0' else '1')+current[1:]
  marker={'startupAdapterSha256':stale if mode=='stale-adapter' else current}
  (runtime/'nemoclaw-windows-runtime.json').write_text(json.dumps(marker))
  locations=['hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py','hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py','tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py']
  for relative in locations:
   file=runtime/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data)
  files=[{'path':relative,'bytes':(runtime/relative).stat().st_size,'sha256':m.digest(runtime/relative)} for relative in ['nemoclaw-windows-runtime.json',*locations]]
  report={'schemaVersion':1,'classification':'native-hermes-generated-metadata-adaptation','hermesRevision':inv.UPSTREAM_COMMIT,'runtimeExecutionQualified':False,'requiresMovedRootProbe':True,'environments':['hermes-agent/venv','tools/browser-use'],'files':files}
  if mode=='modified-adapter':
   changed=bytearray(data);changed[0]^=1;(runtime/locations[0]).write_bytes(changed)
  checked=m.validate_current_adaptation(runtime,report);assert checked==current;result={'currentAdapterSha256':checked,'copies':len(locations)}
 elif mode=='build-only':inv.validate_build_receipt(build);result={'buildOnlyAccepted':True}
 elif mode=='failed-mxc':
  relocation={'schemaVersion':1,'upstreamCommit':inv.UPSTREAM_COMMIT,'status':'fail','targetRoot':str(root)}
  inv.validate_receipts(root,build,relocation);result=None
 elif mode=='fallback':build['installedTier']='core only';inv.validate_build_receipt(build);result=None
 elif mode=='missing-stage':build['stages']=[];inv.validate_build_receipt(build);result=None
 elif mode=='wrong-adapter':m.validate_adaptation(root,{'schemaVersion':1},'0'*64);result=None
 print(json.dumps({'ok':True,'result':result}))
except BaseException as error:print(json.dumps({'ok':False,'type':type(error).__name__,'error':str(error),'traceback':traceback.format_exc()[-12000:]}))
`;
function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-export-"));
  try {
    const p = spawnSync(python, ["-I", "-c", control, exporter, root, mode], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(p.status, 0, p.stderr);
    const result = JSON.parse(p.stdout);
    const evidence = process.env.NEMOCLAW_EXPORT_CONTROL_EVIDENCE;
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, `${mode}.json`),
        JSON.stringify({ fixtureRoot: root, ...result }, null, 2) + "\n",
        { flag: "wx" },
      );
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("candidate archive retains every regular byte, empty directory and unproven declaration", () => {
  const value = run("archive");
  assert.equal(value.ok, true, JSON.stringify(value));
  assert(value.result.bytes > 0);
  const entries = new Map(
    value.result.members.map((m: { name: string; bytes: string | null }) => [m.name, m.bytes]),
  );
  assert.equal(entries.get("runtime/LICENSE"), Buffer.from("license").toString("hex"));
  assert.equal(
    entries.get("runtime/dynamic.dat"),
    Buffer.from("opaque-runtime-bytes").toString("hex"),
  );
  assert(entries.has("runtime/runtime.d.ts"));
  assert(entries.has("runtime/empty"));
});
test("a byte change after inventory prevents candidate archival", () =>
  assert.match(run("drift").error, /changed/u));
test("safe owned links retain portable in-root targets", () => {
  const value = run("link");
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(
    value.result.members.find((m: { name: string }) => m.name === "runtime/resource-link").link,
    "dynamic.dat",
  );
});
test("a real alias of the owned root preserves the same safe portable link", () => {
  const value = run("root-alias");
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.notEqual(value.result.lexicalRoot, value.result.canonicalRoot);
  assert.equal(
    value.result.members.find((m: { name: string }) => m.name === "runtime/resource-link").link,
    "dynamic.dat",
  );
});
test("root alias normalization still refuses an outside target", () =>
  assert.match(run("alias-outside").error, /escapes/u));
test("a link redirected outside after inventory cannot be archived", () =>
  assert.match(run("link-drift").error, /outside target/u));
test("an outside runtime link cannot become candidate bytes", () =>
  assert.match(run("outside-link").error, /escapes/u));
test("candidate adaptation binds all three installed hooks to the current pinned source", () => {
  const value = run("current-adapter");
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.result.copies, 3);
  assert.match(value.result.currentAdapterSha256, /^[a-f0-9]{64}$/u);
});
test("a stale adapter binding cannot satisfy current-source provenance", () =>
  assert.match(run("stale-adapter").error, /exact current startup adapter/u));
test("same-size hook mutation after adaptation is refused", () =>
  assert.match(run("modified-adapter").error, /metadata changed/u));
test("candidate build admission does not weaken the separate failed MXC qualification gate", () => {
  assert.equal(run("build-only").ok, true);
  assert.match(run("failed-mxc").error, /not passed/u);
});
for (const mode of ["fallback", "missing-stage", "wrong-adapter"])
  test(`candidate build refuses ${mode}`, () => assert.equal(run(mode).ok, false));
