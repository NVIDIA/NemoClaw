#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Startup config readers use the policy-visible package path. OpenClaw 10.5
# hoists JSON5 into the reviewed runtime graph; retain that path without adding
# or resolving another package. Historical runtimes keep their bundled copy.
set -eu
rm -f /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw \
  && install -o root -g root -m 0755 \
    /usr/local/lib/nemoclaw/openclaw-cli-wrapper.sh \
    /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/nemoclaw-cli-wrapper.sh \
  && ln -s ../openclaw/nemoclaw-cli-wrapper.sh \
    /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/.bin/openclaw \
  && if [ ! -e /usr/local/lib/node_modules/openclaw/node_modules/json5 ]; then
    openclaw_json5_root="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); const r=require("node:module").createRequire(fs.realpathSync("/usr/local/lib/node_modules/openclaw/package.json")); process.stdout.write(path.dirname(r.resolve("json5/package.json")));')"
    mkdir -p /usr/local/lib/node_modules/openclaw/node_modules
    ln -s "$openclaw_json5_root" /usr/local/lib/node_modules/openclaw/node_modules/json5
  fi \
  && node -e 'const JSON5=require("/usr/local/lib/node_modules/openclaw/node_modules/json5"); if (typeof JSON5.parse !== "function") process.exit(1)' \
  && openclaw_json5_unsafe="$(find -L /usr/local/lib/node_modules/openclaw/node_modules/json5 \( ! -user root -o -perm /022 \) -print -quit)" \
  && test -z "$openclaw_json5_unsafe"
