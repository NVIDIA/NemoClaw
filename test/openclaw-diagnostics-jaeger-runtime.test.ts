// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { remediateReviewedOpenClawPluginArchive } from "../scripts/lib/openclaw-npm-remediation.mts";
import { packReviewedNpmArchive } from "../scripts/lib/reviewed-npm-archive.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const RUNTIME_HARNESS_ENV = "NEMOCLAW_REAL_OPENCLAW_JAEGER_HARNESS";
const RUNTIME_TIMEOUT_MS = 180_000;

interface ReviewedPackage {
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}

const JAEGER_RUNTIME_PROBE = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const diagnosticsRoot = process.argv[1];
assert.ok(path.isAbsolute(diagnosticsRoot), "diagnostics root must be absolute");

const diagnosticsRequire = createRequire(path.join(diagnosticsRoot, "package.json"));
const sdkEntry = diagnosticsRequire.resolve("@opentelemetry/sdk-node");
const sdkRequire = createRequire(sdkEntry);
const jaegerEntry = sdkRequire.resolve("@opentelemetry/propagator-jaeger");
const jaegerRequire = createRequire(jaegerEntry);
const { JaegerPropagator } = sdkRequire("@opentelemetry/propagator-jaeger");
const { ROOT_CONTEXT, propagation, trace } = jaegerRequire("@opentelemetry/api");

let packageRoot = path.dirname(jaegerEntry);
let packageJson;
while (packageRoot !== path.dirname(packageRoot)) {
  const candidate = path.join(packageRoot, "package.json");
  if (fs.existsSync(candidate)) {
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
    if (parsed.name === "@opentelemetry/propagator-jaeger") {
      packageJson = parsed;
      break;
    }
  }
  packageRoot = path.dirname(packageRoot);
}
assert.ok(packageJson, "could not resolve the physical Jaeger package identity");
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
assert.ok(versionMatch, "Jaeger package must use a stable semantic version");
const version = versionMatch.slice(1).map(Number);
assert.ok(
  version[0] > 2 || (version[0] === 2 && (version[1] > 9 || (version[1] === 9 && version[2] >= 0))),
  "Jaeger package must be at least 2.9.0",
);

const propagator = new JaegerPropagator();
const getter = {
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

for (const malformed of ["%ZZ", "abc%G:123:0:01", "%"]) {
  const context = propagator.extract(
    ROOT_CONTEXT,
    { "uber-trace-id": malformed },
    getter,
  );
  assert.equal(
    trace.getSpanContext(context),
    undefined,
    "malformed uber-trace-id must be ignored: " + malformed,
  );
}

const baggageFromMalformedTrace = propagator.extract(
  ROOT_CONTEXT,
  { "uber-trace-id": "%ZZ", "uberctx-test": "value" },
  getter,
);
assert.equal(trace.getSpanContext(baggageFromMalformedTrace), undefined);
assert.equal(propagation.getBaggage(baggageFromMalformedTrace)?.getEntry("test")?.value, "value");

const validTraceWithMalformedBaggage = propagator.extract(
  ROOT_CONTEXT,
  {
    "uber-trace-id": "d4cda95b652f4a1592b449d5929fda1b:6e0c63257de34c92:0:01",
    "uberctx-bad": "%ZZ",
    "uberctx-test": "value",
  },
  getter,
);
assert.deepEqual(trace.getSpanContext(validTraceWithMalformedBaggage), {
  traceId: "d4cda95b652f4a1592b449d5929fda1b",
  spanId: "6e0c63257de34c92",
  traceFlags: 1,
  isRemote: true,
});
const baggage = propagation.getBaggage(validTraceWithMalformedBaggage);
assert.equal(baggage?.getEntry("bad"), undefined);
assert.equal(baggage?.getEntry("test")?.value, "value");

console.log(JSON.stringify({
  jaegerVersion: packageJson.version,
  malformedTraceHeaders: 3,
  malformedBaggageIgnored: true,
  validTracePreserved: true,
}));
`;

function reviewedDiagnosticsPackage(): ReviewedPackage {
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
  ) as { archivePackages: ReviewedPackage[] };
  const reviewed = config.archivePackages.find(({ packageSpec }) =>
    packageSpec.startsWith("@openclaw/diagnostics-otel@"),
  );
  assert.ok(reviewed, "reviewed npm audit config must include OpenClaw diagnostics");
  return reviewed;
}

function requireSpawnSuccess(
  result: ReturnType<typeof spawnSync>,
  label: string,
): asserts result is ReturnType<typeof spawnSync> & { status: 0 } {
  const detail = result.error?.message || result.stderr || result.stdout || "empty output";
  assert.equal(result.error, undefined, `${label} failed: ${detail}`);
  assert.equal(result.status, 0, `${label} failed: ${detail}`);
}

describe.skipIf(process.env[RUNTIME_HARNESS_ENV] !== "1")(
  "OpenClaw diagnostics Jaeger runtime",
  () => {
    it(
      "ignores malformed trace and baggage headers in the reviewed production graph (#7337)",
      () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-jaeger-runtime-"));
        try {
          const home = path.join(workspace, "home");
          const cache = path.join(workspace, "npm-cache");
          fs.mkdirSync(home, { recursive: true, mode: 0o700 });
          fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: home,
            NPM_CONFIG_AUDIT: "false",
            NPM_CONFIG_CACHE: cache,
            NPM_CONFIG_FUND: "false",
            NPM_CONFIG_IGNORE_SCRIPTS: "true",
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
            NPM_CONFIG_USERCONFIG: "/dev/null",
          };
          const reviewed = reviewedDiagnosticsPackage();
          const archive = packReviewedNpmArchive({
            env,
            expectedIntegrity: reviewed.integrity,
            label: reviewed.label,
            packageSpec: reviewed.packageSpec,
            tarballUrl: reviewed.tarballUrl,
            tempDirectory: workspace,
          });
          const productionArchive = remediateReviewedOpenClawPluginArchive({
            archivePath: archive.archivePath,
            env,
            packageSpec: reviewed.packageSpec,
            workingDirectory: archive.rootDirectory,
          });
          const runtime = path.join(workspace, "runtime");
          const install = spawnSync(
            "npm",
            [
              "install",
              "--prefix",
              runtime,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              productionArchive.archivePath,
            ],
            { encoding: "utf-8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          requireSpawnSuccess(install, "install reviewed diagnostics archive");

          const diagnosticsRoot = path.join(
            runtime,
            "node_modules",
            "@openclaw",
            "diagnostics-otel",
          );
          const probe = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", JAEGER_RUNTIME_PROBE, diagnosticsRoot],
            {
              encoding: "utf-8",
              env: { HOME: home, NODE_OPTIONS: "", PATH: process.env.PATH },
              timeout: RUNTIME_TIMEOUT_MS,
            },
          );
          requireSpawnSuccess(probe, "execute reviewed Jaeger runtime probe");
          expect(JSON.parse(probe.stdout)).toMatchObject({
            malformedBaggageIgnored: true,
            malformedTraceHeaders: 3,
            validTracePreserved: true,
          });
        } finally {
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      },
      RUNTIME_TIMEOUT_MS,
    );
  },
);
