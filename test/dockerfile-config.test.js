// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dockerfilePath = path.join(__dirname, "..", "Dockerfile");
const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

describe("sandbox Dockerfile config layout", () => {
  it("stores openclaw.json in writable sandbox state", () => {
    assert.match(
      dockerfile,
      /ln -s \/sandbox\/\.openclaw-data\/openclaw\.json \/sandbox\/\.openclaw\/openclaw\.json/,
    );
    assert.match(
      dockerfile,
      /ln -s \/sandbox\/\.openclaw-data\/identity \/sandbox\/\.openclaw\/identity/,
    );
    assert.doesNotMatch(dockerfile, /chmod 444 \/sandbox\/\.openclaw\/openclaw\.json/);
  });
});
