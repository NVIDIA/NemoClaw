// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const image = process.env.NEMOCLAW_HERMES_TEST_IMAGE;
const proof = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {spawnSync} = require("node:child_process");
const uid = Number(spawnSync("/usr/bin/id", ["-u", "sandbox"], {encoding:"utf8"}).stdout.trim());
const gid = Number(spawnSync("/usr/bin/id", ["-g", "sandbox"], {encoding:"utf8"}).stdout.trim());
assert.ok(uid > 0 && gid > 0);
for (const mode of [0o700, 0o3770]) {
fs.chownSync("/sandbox/.hermes", uid, gid);
const source = "/sandbox/.hermes/managed-policy.json";
const policy = JSON.stringify({schema_version:3}) + String.fromCharCode(10);
// The owner can preserve setgid without granting root CAP_FSETID.
const generated = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'); fs.chmodSync('/sandbox/.hermes', Number(process.argv[3])); fs.writeFileSync(process.argv[1], process.argv[2], {mode:0o600})", source, policy, String(mode)], {
  uid, gid, env:{PATH:"/usr/bin:/bin"}, encoding:"utf8", timeout:10000,
});
assert.equal(generated.status, 0, generated.stderr);
assert.equal(fs.statSync("/sandbox/.hermes").mode & 0o7777, mode);
assert.throws(() => fs.unlinkSync(source), {code:"EACCES"});
const runtime = require("/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs");
runtime.installHermesManagedPolicy();
assert.throws(() => fs.lstatSync(source), {code:"ENOENT"});
const target = "/usr/local/share/nemoclaw/hermes-managed-policy.json";
assert.equal(fs.readFileSync(target,"utf8"), policy);
assert.equal(fs.statSync(target).uid, 0);
assert.equal(fs.statSync(target).gid, 0);
assert.equal(fs.statSync(target).mode & 0o777, 0o444);
assert.equal(fs.statSync("/sandbox/.hermes").mode & 0o7777, mode);
}
console.log("Hermes policy promotion and owner cleanup passed without DAC override");
`;

it.runIf(Boolean(image))(
  "installs policy and removes its source without DAC override for private and canonical parents (#13684)",
  () => {
    const name = `hermes-policy-cleanup-${randomUUID()}`;
    try {
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "FOWNER",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--cap-add",
          "DAC_READ_SEARCH",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "0:0",
          "--tmpfs",
          "/sandbox/.hermes:rw,nosuid,nodev,mode=0700",
          "--tmpfs",
          "/usr/local/share/nemoclaw:rw,nosuid,nodev,mode=0755",
          "--entrypoint",
          "/usr/local/bin/node",
          image!,
          "-e",
          proof,
        ],
        { encoding: "utf8", timeout: 45_000, killSignal: "SIGKILL" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("owner cleanup passed without DAC override");
    } finally {
      const removed = spawnSync("docker", ["rm", "--force", name], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(removed.error).toBeUndefined();
      expect(
        removed.status === 0 || removed.stderr.includes("No such container"),
        `cleanup ${name}`,
      ).toBe(true);
      const absence = spawnSync("docker", ["container", "inspect", name], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(absence.error).toBeUndefined();
      expect(absence.status).not.toBe(0);
      expect(absence.stderr).toMatch(/No such (object|container)/u);
    }
  },
  90_000,
);
