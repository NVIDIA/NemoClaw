// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI input fetch only. The unmodified official installer still installs and
// builds the full graph within its existing command deadlines.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type Package = {
  link?: boolean;
  resolved?: string;
  integrity?: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
};
type Input = { url: string; integrity: string; locations: string[] };
type StreamIdentity = { bytes: number; sha256: string };
type NpmApi = {
  checkPlatform(pkg: Package, force: false, environment: { os: string; cpu: string }): void;
  stream(
    url: string,
    consume: (source: AsyncIterable<Buffer>) => Promise<StreamIdentity>,
    options: Record<string, unknown>,
  ): Promise<StreamIdentity>;
};

export function npmApi(npmRoot: string): NpmApi {
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8")).version,
    "10.9.8",
    "The npm input API must be the pinned Node distribution's version.",
  );
  const require = createRequire(path.join(npmRoot, "package.json"));
  return {
    checkPlatform: require("npm-install-checks").checkPlatform,
    stream: require("pacote").tarball.stream,
  };
}

export function lockedInputs(
  lock: { lockfileVersion?: number; packages?: Record<string, Package> },
  api: NpmApi,
) {
  assert.equal(lock.lockfileVersion, 3);
  assert.ok(lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages));
  assert.ok(Object.keys(lock.packages).length <= 5000);
  const selected = new Map<string, Input>(),
    skipped: string[] = [];
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (pkg.link || !pkg.resolved) continue;
    const url = new URL(pkg.resolved);
    assert.ok(
      pkg.resolved.length <= 2048 &&
        url.origin === "https://registry.npmjs.org" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.endsWith(".tgz"),
    );
    assert.match(pkg.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/u);
    try {
      api.checkPlatform(pkg, false, { os: "win32", cpu: "arm64" });
    } catch (error) {
      if ((error as { code?: string }).code !== "EBADPLATFORM") throw error;
      skipped.push(location);
      continue;
    }
    const old = selected.get(pkg.resolved);
    if (old) {
      assert.equal(old.integrity, pkg.integrity);
      old.locations.push(location);
    } else
      selected.set(pkg.resolved, {
        url: pkg.resolved,
        integrity: pkg.integrity!,
        locations: [location],
      });
  }
  assert.ok(selected.size > 0, "The locked npm graph contains no applicable archive inputs.");
  return { selected: [...selected.values()], skipped };
}

export async function cacheInput(input: Input, cache: string, api: NpmApi) {
  const identity = await api.stream(
    input.url,
    async (source) => {
      let bytes = 0;
      const hash = createHash("sha512");
      const sha256 = createHash("sha256");
      for await (const chunk of source) {
        bytes += chunk.length;
        assert.ok(bytes <= 256 * 1024 * 1024, "A locked npm archive exceeded its input bound.");
        hash.update(chunk);
        sha256.update(chunk);
      }
      assert.equal("sha512-" + hash.digest("base64"), input.integrity);
      return { bytes, sha256: sha256.digest("hex") };
    },
    {
      cache: path.join(cache, "_cacache"),
      resolved: input.url,
      integrity: input.integrity,
      preferOnline: false,
      fetchRetries: 0,
      fetchTimeout: 60000,
      ignoreScripts: true,
    },
  );
  return { ...input, ...identity };
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(process.env.CI, "1");
  const args = process.argv.slice(2);
  assert.equal(args.length, 4);
  const [npmRoot, lockPath, cache, receipt] = args.map((value) => path.resolve(value));
  assert.equal(fs.existsSync(receipt), false);
  const original = fs.readFileSync(lockPath),
    api = npmApi(npmRoot);
  const inputs = lockedInputs(JSON.parse(original.toString("utf8")), api);
  const records: Awaited<ReturnType<typeof cacheInput>>[] = [];
  let next = 0,
    failure: unknown;
  const started = performance.now();
  try {
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < inputs.selected.length && failure === undefined) {
          const item = inputs.selected[next++];
          try {
            records.push(await cacheInput(item, cache, api));
          } catch (error) {
            failure ??= error;
          }
          if (records.length % 32 === 0)
            console.log(
              `[Hermes npm inputs] ${records.length}/${inputs.selected.length} archives verified in ${Math.round((performance.now() - started) / 1000)}s`,
            );
        }
      }),
    );
    if (failure !== undefined) throw failure;
    assert.deepEqual(fs.readFileSync(lockPath), original);
    assert.equal(records.length, inputs.selected.length);
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      fs.writeFileSync(
        receipt,
        JSON.stringify(
          {
            schemaVersion: 1,
            classification: "official-npm-locked-input-cache",
            npmVersion: "10.9.8",
            lockSha256: createHash("sha256").update(original).digest("hex"),
            platform: "win32",
            architecture: "arm64",
            concurrency: 8,
            elapsedMs: performance.now() - started,
            inputsExpected: inputs.selected.length,
            inputsVerified: records.length,
            skippedPrefetchLocations: inputs.skipped,
            inputCacheOnly: true,
            runtimeGraphModified: false,
            installScriptsRun: false,
            status: failure === undefined ? "inputs-cached" : "failed",
            error: failure instanceof Error ? failure.message : null,
            archives: records.sort((a, b) => a.url.localeCompare(b.url)),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
