// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheInput, lockedInputs, npmApi } from "./prefetch-official-npm.mts";

const npmRoot = [
  path.join(path.dirname(process.execPath), "node_modules/npm"),
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm"),
].find((root) => existsSync(path.join(root, "package.json")))!;
const api = npmApi(npmRoot),
  require = createRequire(path.join(npmRoot, "package.json"));
const integrity = "sha512-" + Buffer.alloc(64, 7).toString("base64");
const pkg = { resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity };

test("pinned npm selects the applicable input cache without editing the full graph", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/a": pkg,
      "node_modules/b/node_modules/a": pkg,
      "node_modules/foreign": { ...pkg, cpu: ["x64"], os: ["darwin"] },
      "local-workspace": { link: true, resolved: "apps/desktop" },
    },
  };
  const before = JSON.stringify(lock),
    value = lockedInputs(lock, api);
  assert.equal(value.selected.length, 1);
  assert.deepEqual(value.selected[0].locations, [
    "node_modules/a",
    "node_modules/b/node_modules/a",
  ]);
  assert.deepEqual(value.skipped, ["node_modules/foreign"]);
  assert.equal(JSON.stringify(lock), before);
});
for (const changed of [
  { ...pkg, resolved: "http://registry.npmjs.org/fixture.tgz" },
  { ...pkg, resolved: "https://foreign.invalid/fixture.tgz" },
  { ...pkg, resolved: "https://registry.npmjs.org:9443/fixture.tgz" },
  { ...pkg, resolved: "https://user@registry.npmjs.org/fixture.tgz" },
  { ...pkg, integrity: undefined },
  { ...pkg, integrity: "sha1-unsupported" },
])
  test("noncanonical input identity is refused before download", () => {
    assert.throws(() => lockedInputs({ lockfileVersion: 3, packages: { a: changed } }, api));
  });
test("different locked integrity for one URL is refused", () => {
  assert.throws(() =>
    lockedInputs(
      {
        lockfileVersion: 3,
        packages: {
          a: pkg,
          b: { ...pkg, integrity: "sha512-" + Buffer.alloc(64, 8).toString("base64") },
        },
      },
      api,
    ),
  );
});

test("actual npm consumes the verified prefetched archive offline and only then runs its install hook", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-npm-cache-control-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(tarball);
  });
  let tarball: Buffer;
  try {
    const source = path.join(directory, "package");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "hermes-input-cache-control",
        version: "1.0.0",
        scripts: { install: "node install.cjs" },
      }),
    );
    await fs.writeFile(
      path.join(source, "install.cjs"),
      'require("node:fs").writeFileSync("hook-ran", "installed");',
    );
    const archive = path.join(directory, "input.tgz");
    await require("tar").c({ cwd: directory, file: archive, gzip: true }, ["package"]);
    tarball = await fs.readFile(archive);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/package.tgz`;
    const input = {
      url,
      integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
      locations: ["node_modules/hermes-input-cache-control"],
    };
    const cache = path.join(directory, "cache");
    const cached = await cacheInput(input, cache, api);
    assert.equal(cached.bytes, tarball.length);
    assert.equal(cached.sha256, createHash("sha256").update(tarball).digest("hex"));
    assert.equal(existsSync(path.join(source, "hook-ran")), false);
    assert.equal(existsSync(path.join(directory, "node_modules")), false);
    await assert.rejects(
      cacheInput({ ...input, integrity }, path.join(directory, "wrong-cache"), api),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const app = path.join(directory, "app");
    await fs.mkdir(app);
    const manifest = {
      name: "hermes-cache-consumer",
      version: "1.0.0",
      dependencies: { "hermes-input-cache-control": "1.0.0" },
    };
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify(manifest));
    const lock = JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: {
        "": manifest,
        "node_modules/hermes-input-cache-control": {
          version: "1.0.0",
          resolved: url,
          integrity: input.integrity,
          hasInstallScript: true,
        },
      },
    });
    await fs.writeFile(path.join(app, "package-lock.json"), lock);
    const emptyConfig = path.join(directory, "empty.npmrc");
    await fs.writeFile(emptyConfig, "");
    const globalConfig = path.join(directory, "global.npmrc");
    await fs.writeFile(globalConfig, "");
    const child = spawn(
      process.execPath,
      [path.join(npmRoot, "bin/npm-cli.js"), "ci", "--offline", "--no-audit", "--no-fund"],
      {
        cwd: app,
        env: {
          ...process.env,
          npm_config_cache: cache,
          npm_config_userconfig: emptyConfig,
          npm_config_globalconfig: globalConfig,
          PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ""),
          npm_config_ignore_scripts: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      assert.equal(
        await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
        0,
        output,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      await fs.readFile(path.join(app, "node_modules/hermes-input-cache-control/hook-ran"), "utf8"),
      "installed",
    );
    assert.equal(await fs.readFile(path.join(app, "package-lock.json"), "utf8"), lock);
    const again = await cacheInput(input, cache, api);
    assert.equal(again.bytes, tarball.length);
    assert.equal(again.sha256, cached.sha256);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
