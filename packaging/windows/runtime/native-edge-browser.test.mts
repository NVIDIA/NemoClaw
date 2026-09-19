// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseDevToolsActivePort,
  peMachine,
  standardEdgeCandidates,
  validateEdgeMetadata,
  readNativeEdgeEndpoint,
  transientEdgeEndpointRead,
} from "./native-edge-browser.mts";

test("Edge reads only a bounded ordinary endpoint file", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-edge-endpoint-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "DevToolsActivePort");
  assert.equal(readNativeEdgeEndpoint(file), null);
  fs.writeFileSync(file, "51234\n/devtools/browser/owned\n");
  assert.deepEqual(readNativeEdgeEndpoint(file), { port: 51234, path: "/devtools/browser/owned" });
  const link = path.join(root, "redirected");
  fs.symlinkSync(file, link);
  assert.throws(() => readNativeEdgeEndpoint(link), /link or changed identity/u);
  fs.writeFileSync(file, "x".repeat(513));
  assert.throws(() => readNativeEdgeEndpoint(file), /exceeds its limit/u);
  fs.writeFileSync(file, "51234\nhttps://example.test/\n");
  assert.throws(() => readNativeEdgeEndpoint(file), /valid CDP endpoint/u);
});

test("only a transient Edge endpoint file lock is retryable", () => {
  assert.equal(
    transientEdgeEndpointRead(Object.assign(new Error("locked"), { code: "EBUSY" })),
    true,
  );
  for (const code of ["EACCES", "ENOENT", "EPERM", undefined])
    assert.equal(
      transientEdgeEndpointRead(Object.assign(new Error("not transient"), { code })),
      false,
    );
});

test("Edge endpoint polling has one deadline owner", () => {
  const source = fs.readFileSync(new URL("./native-edge-browser.mts", import.meta.url), "utf8");
  assert.match(source, /while \(Date\.now\(\) < deadline\)/u);
  assert.doesNotMatch(source, /while \(!endpoint\s*&&/u);
});

test("Edge retries only transient Windows endpoint sharing violations", () => {
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    let attempts = 0;
    const result = readNativeEdgeEndpoint("C:\\owned\\DevToolsActivePort", {
      platform: "win32",
      read: () => {
        attempts += 1;
        throw Object.assign(new Error("transient sharing violation"), { code });
      },
    });
    assert.equal(result, null);
    assert.equal(attempts, 1);
  }
  for (const [platform, code] of [
    ["linux", "EBUSY"],
    ["win32", "EIO"],
  ] as const)
    assert.throws(() =>
      readNativeEdgeEndpoint("C:\\owned\\DevToolsActivePort", {
        platform,
        read: () => {
          throw Object.assign(new Error("non-retryable endpoint failure"), { code });
        },
      }),
    );
});

test("only standard Edge installation roots are candidates", () => {
  assert.deepEqual(
    standardEdgeCandidates({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      PATH: "C:\\arbitrary\\Brave;C:\\Chromium",
      LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local",
    }),
    [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  );
});

test("Edge executable must be ARM64 PE", () => {
  const image = Buffer.alloc(128);
  image.write("MZ");
  image.writeUInt32LE(64, 60);
  image.write("PE\0\0", 64);
  image.writeUInt16LE(0xaa64, 68);
  assert.equal(peMachine(image), 0xaa64);
  image.writeUInt16LE(0x8664, 68);
  assert.equal(peMachine(image), 0x8664);
  assert.throws(() => peMachine(Buffer.alloc(63)));
});

test("Edge metadata requires a valid Microsoft signature and exact path", () => {
  const path = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
  const value = {
    path,
    version: "151.0.1000.1",
    productName: "Microsoft Edge",
    originalFilename: "msedge.exe",
    reparsePoint: false,
    signatureStatus: "Valid",
    signerSubject: "CN=Microsoft Corporation, O=Microsoft Corporation, C=US",
    signerThumbprint: "A".repeat(40),
  };
  assert.deepEqual(validateEdgeMetadata(value, path), value);
  for (const change of [
    { path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
    { signatureStatus: "UnknownError" },
    { signerSubject: "CN=Other, O=Other" },
    { version: "unknown" },
    { productName: "WebView2 Manager" },
    { originalFilename: "chrome.exe" },
    { reparsePoint: true },
  ])
    assert.throws(() => validateEdgeMetadata({ ...value, ...change }, path));
  assert.equal(
    validateEdgeMetadata({ ...value, signerSubject: "Microsoft Corporation" }, path).signerSubject,
    "Microsoft Corporation",
  );
});

test("DevTools endpoint is an ephemeral port and exact browser path", () => {
  assert.deepEqual(parseDevToolsActivePort("51234\n/devtools/browser/01234567-abcd\n"), {
    port: 51234,
    path: "/devtools/browser/01234567-abcd",
  });
  for (const value of [
    "0\n/devtools/browser/x\n",
    "65536\n/devtools/browser/x\n",
    "51234\n/devtools/page/x\n",
    "51234\nhttp://host\n",
  ])
    assert.throws(() => parseDevToolsActivePort(value));
});
