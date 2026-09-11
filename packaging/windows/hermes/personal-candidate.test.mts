// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  personalRequest,
  removePersonalRoots,
  publishPersonalReceipt,
} from "./probe-personal-candidate.mts";
import { parseComponent } from "./probe-personal-workload.mts";

const verifier = fileURLToPath(new URL("./verify-personal-candidate.py", import.meta.url));
const control = String.raw`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile,traceback,zipfile
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3]
sha=lambda b:hashlib.sha256(b).hexdigest()
hooks=['hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py','hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py','tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py']
data=pathlib.Path(sys.argv[1]).with_name('nemoclaw_native_windows.py').read_bytes()
files={name:data for name in hooks};files['asset.dat']=b'correct payload'
dirs=sorted({p.as_posix() for n in files for p in pathlib.PurePosixPath(n).parents if str(p)!='.'}|{'empty'},key=lambda n:(n.count('/'),n))
rows=[{'path':name,'bytes':len(value),'sha256':sha(value)} for name,value in files.items()]
rows.append({'path':'resource-link','linkTarget':'asset.dat'})
if mode=='outside':rows[-1]['linkTarget']='../outside'
if mode=='cycle':rows[-1]['linkTarget']='resource-link'
if mode=='parent-link':rows.append({'path':'resource-link/unlisted','bytes':0,'sha256':sha(b'')})
inventory={'files':rows,'directories':dirs}
adapt={'files':[row for row in rows if row['path'] in hooks]}
build={'status':'runtime-provisioned','sourceUnchanged':True,'fallbacks':[]}
encoded=lambda value:json.dumps(value).encode()
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w:gz') as tar:
 for directory in dirs:
  item=tarfile.TarInfo('runtime/'+directory);item.type=tarfile.DIRTYPE;tar.addfile(item)
 for name,value in files.items():
  if mode=='hash-drift' and name=='asset.dat':value=b'changed payload'
  item=tarfile.TarInfo('runtime/'+name);item.size=len(value);tar.addfile(item,io.BytesIO(value))
 item=tarfile.TarInfo('runtime/resource-link');item.type=tarfile.SYMTYPE;item.linkname=rows[-1].get('linkTarget','asset.dat');tar.addfile(item)
 if mode=='unlisted':
  item=tarfile.TarInfo('runtime/extra');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
 if mode=='duplicate':
  item=tarfile.TarInfo('runtime/asset.dat');item.size=0;tar.addfile(item,io.BytesIO())
tarbytes=raw.getvalue()
candidate={'controllerSource':m.HEAD,'upstreamCommit':m.UPSTREAM,'status':'candidate-bytes-exported','completeByteInventory':True,'runtimeExecutionQualified':False,'installedAcceptance':False,'activationAllowed':False,'inventorySha256':sha(encoded(inventory)),'buildReceiptSha256':sha(encoded(build)),'adaptationReceiptSha256':sha(encoded(adapt)),'startupAdapterSha256':m.ADAPTER,'archive':{'file':'candidate.tar.gz','bytes':len(tarbytes),'sha256':sha(tarbytes)}}
if mode=='wrong-source':candidate['controllerSource']='0'*40
if mode=='wrong-adapter':candidate['startupAdapterSha256']='0'*64
if mode=='false-qualified':candidate['runtimeExecutionQualified']=True
zipfile_path=root/'artifact.zip'
with zipfile.ZipFile(zipfile_path,'w') as z:
 for name,value in [('runtime-candidate.json',candidate),('payload-inventory.json',inventory),('official-runtime-build.json',build),('native-adaptation.json',adapt)]:z.writestr('evidence/'+name,encoded(value))
 z.writestr('evidence/candidate.tar.gz',tarbytes)
expected_size=zipfile_path.stat().st_size;expected_hash=m.digest(zipfile_path)
if mode=='zip-hash':
 rawzip=bytearray(zipfile_path.read_bytes());rawzip[-1]^=1;zipfile_path.write_bytes(rawzip)
if mode=='zip-size':expected_size+=1
try:
 m.verify_zip(zipfile_path,expected_size,expected_hash)
 with zipfile.ZipFile(zipfile_path) as z:
  details=m.documents(z);size=m.verify_members(z,details)
  m.extract_verified(z,details,root/'runtime')
 result={'ok':True,'bytes':size,'regular':(root/'runtime/asset.dat').read_bytes().decode(),'link':(root/'runtime/resource-link').read_bytes().decode(),'empty':(root/'runtime/empty').is_dir()}
except BaseException as error:result={'ok':False,'error':str(error),'traceback':traceback.format_exc()[-12000:],'extracted':(root/'runtime').exists()}
print(json.dumps(result))
`;

function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-candidate-"));
  try {
    const child = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
      ["-I", "-c", control, verifier, root, mode],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    const evidence = process.env.NEMOCLAW_PERSONAL_CONTROL_EVIDENCE;
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, mode + ".json"),
        JSON.stringify(result, null, 2) + "\n",
        { flag: "wx" },
      );
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("verified nested bytes retain regular data, a safe link and an empty directory", () => {
  const result = run("valid");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regular, "correct payload");
  assert.equal(result.link, "correct payload");
  assert.equal(result.empty, true);
});
for (const [mode, expected] of [
  ["zip-hash", /ZIP hash\/size mismatch/u],
  ["zip-size", /ZIP hash\/size mismatch/u],
  ["hash-drift", /file hash mismatch/u],
  ["outside", /leaves or misses/u],
  ["cycle", /Cyclic/u],
  ["parent-link", /traverses a link parent/u],
  ["unlisted", /size\/type/u],
  ["duplicate", /Duplicate nested/u],
  ["wrong-source", /unexpected identity/u],
  ["wrong-adapter", /wrong reviewed/u],
  ["false-qualified", /qualification claim/u],
] as const) {
  test(`${mode} refuses the candidate before runtime extraction`, () => {
    const result = run(mode);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, expected);
    assert.equal(result.extracted, false);
  });
}

test("Personal request matches the existing driver profile and keeps filesystem grants exact", () => {
  const request = personalRequest(
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\runtime",
    "C:\\share",
    "1234567890abcdef12345678",
    "C:\\Windows",
  );
  assert.deepEqual(request.processContainer, {
    leastPrivilege: false,
    capabilities: ["privateNetworkClientServer", "internetClient"],
  });
  assert.deepEqual(request.network, {
    defaultPolicy: "allow",
    allowedHosts: [],
    blockedHosts: [],
    allowLocalNetwork: true,
  });
  assert.deepEqual(request.filesystem, {
    readonlyPaths: ["C:\\runtime", "C:\\node"],
    readwritePaths: ["C:\\share"],
  });
  assert.equal(request.ui.disable, false);
  assert.equal(request.process.timeout, 120_000);
  assert(
    !request.process.env.some(
      (value) => value.startsWith("GH_TOKEN=") || value.startsWith("NVIDIA_API_KEY="),
    ),
  );
  assert(request.process.env.includes("HERMES_DISABLE_LAZY_INSTALLS=1"));
});
test("the fixed request rejects a command-line quote or invalid nonce", () => {
  assert.throws(
    () =>
      personalRequest(
        'C:\\bad"\\node.exe',
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "1234567890abcdef12345678",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
  assert.throws(
    () =>
      personalRequest(
        "C:\\node.exe",
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "wrong",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
});
test("component evidence requires one exact nonce and operation result", () => {
  const line =
    "NEMOCLAW_PERSONAL_RESULT=" +
    JSON.stringify({ schemaVersion: 1, component: "bash", nonce: "one", passed: false });
  assert.equal(parseComponent(line, "bash", "one").passed, false);
  assert.throws(() => parseComponent(line, "browser", "one"), /identity/u);
  assert.throws(() => parseComponent(line, "bash", "two"), /identity/u);
  assert.throws(() => parseComponent(line + "\n" + line, "bash", "one"), /exactly one/u);
});

test("an unclosed executor retains its files until confirmed closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-"));
  const file = path.join(root, "owned.txt");
  try {
    fs.writeFileSync(file, "owned");
    assert.equal(removePersonalRoots([root], true, false).removed, false);
    assert.equal(fs.readFileSync(file, "utf8"), "owned");
    assert.deepEqual(removePersonalRoots([root], true, true), { removed: true, errors: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real receipt write failure preserves the primary error and reports its own failure separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-receipt-"));
  try {
    const reports: unknown[] = [];
    assert.equal(
      publishPersonalReceipt(root, {}, new Error("original operation"), (value) =>
        reports.push(value),
      ),
      false,
    );
    assert.match(JSON.stringify(reports[0]), /original operation/u);
    assert.match(JSON.stringify(reports[1]), /receiptWriteError/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
