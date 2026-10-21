// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createRequire } from "node:module";

for (const root of process.argv.slice(2)) {
  const require = createRequire(`${root}/package.json`);
  const sharp = require("sharp");
  assert.equal(sharp.versions.sharp, "0.35.4");
  assert.equal(sharp.versions.heif, "1.23.2");
  for (const format of ["png", "jpeg", "avif"]) {
    const encoded = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "white" },
    })
      .toFormat(format)
      .toBuffer();
    const resized = await sharp(encoded).resize(8, 6).raw().toBuffer({ resolveWithObject: true });
    assert.equal(resized.info.width, 8);
    assert.equal(resized.info.height, 6);
  }
  await assert.rejects(sharp(Buffer.from("invalid image")).metadata());
  console.log(`Sharp security probes passed: ${root}`);
}
assert.ok(process.argv.length > 2, "at least one bridge installation is required");
