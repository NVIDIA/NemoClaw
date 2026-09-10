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
import importlib.util,sys,json,pathlib,tarfile,hashlib
spec=importlib.util.spec_from_file_location('exporter',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3];inv=m.load_inventory()
build={'schemaVersion':1,'upstreamCommit':inv.UPSTREAM_COMMIT,'status':'runtime-provisioned','installedTier':'hash-verified (uv.lock)','sourceUnchanged':True,'fallbacks':[],'stages':[{'stage':s,'ok':True,'skipped':False} for s in inv.REQUIRED_STAGES]}
try:
 if mode in ('archive','drift','link'):
  runtime=root/'runtime';runtime.mkdir();(runtime/'empty').mkdir();(runtime/'LICENSE').write_bytes(b'license');(runtime/'dynamic.dat').write_bytes(b'opaque-runtime-bytes');(runtime/'runtime.d.ts').write_text('unpruned');
  if mode=='link':(runtime/'resource-link').symlink_to(runtime/'dynamic.dat')
  payload=inv.inventory(runtime)
  if mode=='drift':(runtime/'dynamic.dat').write_bytes(b'changed')
  artifact=root/'candidate.tar.gz';result=m.archive_candidate(runtime,payload,artifact)
  with tarfile.open(artifact) as handle:
   members=[{'name':i.name,'link':i.linkname,'bytes':handle.extractfile(i).read().hex() if i.isfile() else None} for i in handle]
  result.update(members=members,payload=payload)
 elif mode=='outside-link':
  runtime=root/'runtime';runtime.mkdir();(root/'outside').write_text('not-a-runtime-file');(runtime/'bad').symlink_to(root/'outside');result=inv.inventory(runtime)
 elif mode=='build-only':inv.validate_build_receipt(build);result={'buildOnlyAccepted':True}
 elif mode=='failed-mxc':
  relocation={'schemaVersion':1,'upstreamCommit':inv.UPSTREAM_COMMIT,'status':'fail','targetRoot':str(root)}
  inv.validate_receipts(root,build,relocation);result=None
 elif mode=='fallback':build['installedTier']='core only';inv.validate_build_receipt(build);result=None
 elif mode=='missing-stage':build['stages']=[];inv.validate_build_receipt(build);result=None
 elif mode=='wrong-adapter':m.validate_adaptation(root,{'schemaVersion':1},'0'*64);result=None
 print(json.dumps({'ok':True,'result':result}))
except BaseException as error:print(json.dumps({'ok':False,'type':type(error).__name__,'error':str(error)}))
`;
function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-export-"));
  try {
    const p = spawnSync(python, ["-I", "-c", control, exporter, root, mode], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("candidate archive retains every regular byte, empty directory and unproven declaration", () => {
  const value = run("archive");
  assert.equal(value.ok, true);
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
  assert.equal(value.ok, true);
  assert.equal(
    value.result.members.find((m: { name: string }) => m.name === "runtime/resource-link").link,
    "dynamic.dat",
  );
});
test("an outside runtime link cannot become candidate bytes", () =>
  assert.match(run("outside-link").error, /escapes/u));
test("candidate build admission does not weaken the separate failed MXC qualification gate", () => {
  assert.equal(run("build-only").ok, true);
  assert.match(run("failed-mxc").error, /not passed/u);
});
for (const mode of ["fallback", "missing-stage", "wrong-adapter"])
  test(`candidate build refuses ${mode}`, () => assert.equal(run(mode).ok, false));
