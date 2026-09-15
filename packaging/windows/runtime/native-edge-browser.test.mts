// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDevToolsActivePort,
  peMachine,
  standardEdgeCandidates,
  validateEdgeMetadata,
} from "./native-edge-browser.mts";

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
