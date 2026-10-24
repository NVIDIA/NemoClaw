// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLegacyMessagingPlanEnvDirect } from "../messaging-plan-test-helper";

const SLACK_INTEGRITY =
  "sha512-6M1M6gL3iXahpalNsYAUuA+wvnV8lbMlNNH2ToegFvaSJcIll4S9kFa5mv3GFoquhMRHQjEjnkXPHP/pXwaWcA==";
const PROXY_ADDR_PATH = "node_modules/@slack/bolt/node_modules/proxy-addr";
const PROXY_ADDR_INTEGRITY =
  "sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ==";
const BODY_PARSER_INTEGRITY =
  "sha512-Ifk1KcLrxaGt1occQagQNFNNOqRt1LFuehEnHHzB8Z6cRgIxRU1TBaiIsUiCdA+gy5PL7Y1IX31DNKkRmxtXjQ==";
const QS_INTEGRITY =
  "sha512-5Px6J7rfHBAGUhNQ3es4YzcOdBBw0SDcVtThJml4RdnKw4tKs2epA0kPZ+K8X+WiHktT93RHVcQ/3ym5aTCgtg==";
const BOLT_DEPENDENCIES = "node_modules/@slack/bolt/node_modules";

function writePackage(directory: string, metadata: Record<string, unknown>): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(metadata));
}

export function writeSlackBundledParserFixture(packageDirectory: string): void {
  const dependencies = path.join(packageDirectory, BOLT_DEPENDENCIES);
  writePackage(path.join(dependencies, "body-parser"), {
    name: "body-parser",
    version: "2.3.0",
    dependencies: {
      bytes: "^3.1.2",
      "content-type": "^2.0.0",
      debug: "^4.4.3",
      "http-errors": "^2.0.1",
      "iconv-lite": "^0.7.2",
      "on-finished": "^2.4.1",
      qs: "^6.15.2",
      "raw-body": "^3.0.2",
      "type-is": "^2.1.0",
    },
    license: "MIT",
    engines: { node: ">=18" },
  });
  writePackage(path.join(dependencies, "body-parser/node_modules/content-type"), {
    name: "content-type",
    version: "2.1.0",
  });
  writePackage(path.join(dependencies, "iconv-lite"), {
    name: "iconv-lite",
    version: "0.7.3",
  });
  writePackage(path.join(dependencies, "qs"), {
    name: "qs",
    version: "6.15.3",
  });
}

export async function createSlackRemediationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-real-remediation-"));
  try {
    const bin = path.join(root, "bin");
    const source = path.join(root, "source");
    const home = path.join(root, "home");
    const packageDirectory = path.join(
      home,
      ".openclaw/npm/projects/openclaw-slack-b25c10c1bd/node_modules/@openclaw/slack",
    );
    const trace = path.join(root, "trace");
    fs.mkdirSync(bin);
    fs.symlinkSync("/bin/mkdir", path.join(bin, "mkdir"));
    fs.symlinkSync("/bin/cp", path.join(bin, "cp"));
    fs.symlinkSync("/usr/bin/cmp", path.join(bin, "cmp"));
    fs.mkdirSync(path.join(root, "tmp"));
    writePackage(source, {
      name: "@openclaw/slack",
      version: "2026.9.2",
      dependencies: { "@slack/bolt": "5.0.0" },
      bundledDependencies: ["@slack/bolt"],
    });
    writePackage(path.join(source, "node_modules/@slack/bolt"), {
      name: "@slack/bolt",
      version: "5.0.0",
      dependencies: { express: "^5.0.0" },
      license: "MIT",
      engines: { node: ">=20" },
    });
    writePackage(path.join(source, "node_modules/@slack/bolt/node_modules/express"), {
      name: "express",
      version: "5.2.1",
      dependencies: { "body-parser": "^2.2.1", "proxy-addr": "^2.0.7" },
      license: "MIT",
      engines: { node: ">= 18" },
    });
    writeSlackBundledParserFixture(source);
    writePackage(path.join(source, PROXY_ADDR_PATH), {
      name: "proxy-addr",
      version: "2.0.7",
      dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
      license: "MIT",
      engines: { node: ">= 0.10" },
    });
    fs.writeFileSync(path.join(source, PROXY_ADDR_PATH, "index.js"), "vulnerable fixture\n");
    fs.writeFileSync(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        "set -eu",
        'case "$1:$2:${3:-}" in',
        '  "view:@openclaw/slack@2026.9.2:dist.integrity") printf "%s" "$TEST_SLACK_INTEGRITY" ;;',
        '  "view:@openclaw/slack@2026.9.2:dist.tarball") printf "%s" "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.9.2.tgz" ;;',
        '  "pack:@openclaw/slack@2026.9.2:--pack-destination")',
        '    printf "plugin archive fixture" > "$4/slack.tgz"',
        '    printf \'[{"filename":"slack.tgz","integrity":"%s"}]\' "$TEST_SLACK_INTEGRITY" ;;',
        '  "view:proxy-addr@2.0.8:dist.integrity") printf "%s" "$TEST_PROXY_ADDR_INTEGRITY" ;;',
        '  "view:proxy-addr@2.0.8:dist.tarball") printf "%s" "https://registry.npmjs.org/proxy-addr/-/proxy-addr-2.0.8.tgz" ;;',
        '  "pack:proxy-addr@2.0.8:--pack-destination")',
        '    cp "$TEST_PROXY_ADDR_ARCHIVE" "$4/proxy-addr-2.0.8.tgz"',
        '    printf \'[{"filename":"proxy-addr-2.0.8.tgz","integrity":"%s"}]\' "$TEST_PROXY_ADDR_INTEGRITY" ;;',
        '  "view:body-parser@2.4.0:dist.integrity") printf "%s" "$TEST_BODY_PARSER_INTEGRITY" ;;',
        '  "view:body-parser@2.4.0:dist.tarball") printf "%s" "https://registry.npmjs.org/body-parser/-/body-parser-2.4.0.tgz" ;;',
        '  "pack:body-parser@2.4.0:--pack-destination")',
        '    cp "$TEST_BODY_PARSER_ARCHIVE" "$4/body-parser-2.4.0.tgz"',
        '    printf \'[{"filename":"body-parser-2.4.0.tgz","integrity":"%s"}]\' "$TEST_BODY_PARSER_INTEGRITY" ;;',
        '  "view:qs@6.16.1:dist.integrity") printf "%s" "$TEST_QS_INTEGRITY" ;;',
        '  "view:qs@6.16.1:dist.tarball") printf "%s" "https://registry.npmjs.org/qs/-/qs-6.16.1.tgz" ;;',
        '  "pack:qs@6.16.1:--pack-destination")',
        '    cp "$TEST_QS_ARCHIVE" "$4/qs-6.16.1.tgz"',
        '    printf \'[{"filename":"qs-6.16.1.tgz","integrity":"%s"}]\' "$TEST_QS_INTEGRITY" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.writeFileSync(
      path.join(bin, "openclaw"),
      [
        "#!/bin/sh",
        "set -eu",
        'case "$1:${2:-}" in',
        "  plugins:install)",
        '    mkdir -p "$TEST_SLACK_INSTALL"',
        '    cp -R "$TEST_SLACK_SOURCE/." "$TEST_SLACK_INSTALL/"',
        '    printf "installed\\n" >> "$TEST_SLACK_TRACE" ;;',
        "  plugins:inspect)",
        `    cmp "$TEST_SLACK_SOURCE/${PROXY_ADDR_PATH}/index.js" "$TEST_SLACK_INSTALL/${PROXY_ADDR_PATH}/index.js"`,
        '    printf "inspected-unpatched\\n" >> "$TEST_SLACK_TRACE"',
        '    printf "%s" "$TEST_SLACK_INSPECTION" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const env = await withLegacyMessagingPlanEnvDirect(
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        TMPDIR: path.join(root, "tmp"),
        OPENCLAW_VERSION: "2026.9.2",
        NEMOCLAW_MESSAGING_CHANNELS_B64: Buffer.from('["slack"]').toString("base64"),
        NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: path.resolve(
          import.meta.dirname,
          "../fixtures/npm/proxy-addr-2.0.8",
        ),
        TEST_SLACK_INTEGRITY: SLACK_INTEGRITY,
        TEST_SLACK_SOURCE: source,
        TEST_SLACK_INSTALL: packageDirectory,
        TEST_SLACK_TRACE: trace,
        TEST_PROXY_ADDR_INTEGRITY: PROXY_ADDR_INTEGRITY,
        TEST_BODY_PARSER_INTEGRITY: BODY_PARSER_INTEGRITY,
        TEST_QS_INTEGRITY: QS_INTEGRITY,
        TEST_PROXY_ADDR_ARCHIVE: path.resolve(
          import.meta.dirname,
          "../fixtures/npm/proxy-addr-2.0.8/proxy-addr-2.0.8.tgz",
        ),
        TEST_BODY_PARSER_ARCHIVE: path.resolve(
          import.meta.dirname,
          "../fixtures/npm/proxy-addr-2.0.8/body-parser-2.4.0.tgz",
        ),
        TEST_QS_ARCHIVE: path.resolve(
          import.meta.dirname,
          "../fixtures/npm/proxy-addr-2.0.8/qs-6.16.1.tgz",
        ),
        TEST_SLACK_INSPECTION: JSON.stringify({
          plugin: { id: "slack", trustedOfficialInstall: true },
          install: {
            source: "npm",
            resolvedSpec: "@openclaw/slack@2026.9.2",
            integrity: SLACK_INTEGRITY,
            installPath: packageDirectory,
          },
        }),
      },
      "openclaw",
    );
    return {
      root,
      bin,
      env,
      trace,
      proxyAddrDirectory: path.join(packageDirectory, PROXY_ADDR_PATH),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
