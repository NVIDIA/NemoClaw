// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

describe("installer runtime preflight", () => {
  it("fails fast with a clear message on unsupported Node.js and npm", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-preflight-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v18.19.1"
  exit 0
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "9.8.1"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Unsupported runtime detected/);
    assert.match(output, /Node\.js >=20 and npm >=10/);
    assert.match(output, /v18\.19\.1/);
    assert.match(output, /9\.8\.1/);
  });
});
