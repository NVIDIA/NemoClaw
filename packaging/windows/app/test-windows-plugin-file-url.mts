// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeWindowsNativePluginRequire } from "./openclaw-app-resources.mts";

const index = process.argv.indexOf("--source-root");
if (index < 0 || !process.argv[index + 1])
  throw new Error("The pinned materialized source root is required.");
const source = path.resolve(process.argv[index + 1]);
const relative = "dist/plugin-module-loader-cache-C4l9L2gm.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const admitted = normalizeWindowsNativePluginRequire(relative, original);

// OpenClaw 2026.9.1 contains the Windows native/file-URL handling that the
// 2026.7.1 application build had to add locally. The app compiler now admits
// the exact reviewed upstream implementation without modifying it.
assert.equal(admitted, original);
assert.match(original, /allowWindows: true/u);
assert.match(original, /target\.startsWith\("file:"\) \? fileURLToPath\(target\) : target/u);
assert.match(original, /jitiLoader\(toSourceTransformImportPath\(target\)\)/u);
assert.equal(normalizeWindowsNativePluginRequire("unrelated.js", original), original);
assert.throws(
  () => normalizeWindowsNativePluginRequire(relative, original + "\n"),
  /reviewed native plugin loader changed/u,
);
console.log(
  JSON.stringify({
    passed: true,
    controls: 5,
    upstreamWindowsNativeAdmission: true,
    localSourcePatchRequired: false,
  }),
);
