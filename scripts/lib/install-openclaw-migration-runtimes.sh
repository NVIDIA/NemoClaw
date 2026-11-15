#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu
case "${1:-}" in
  install)
    set -eu
    for migration_version in 2026.9.5 2026.9.7; do
      migration_root="/usr/local/lib/nemoclaw/openclaw-migrations/$migration_version"
      case "$migration_version" in
        2026.9.5)
          migration_lock=b2864b729531e606de939b50d6b64001b1e97e0b17acf1e2f69c0a5792aa9c93
          migration_integrity='sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w=='
          ;;
        2026.9.7)
          migration_lock=35020ee3d2638c8b5f784387085836c0d7fb62dfe1309097d53da235247197a5
          migration_integrity='sha512-/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA=='
          ;;
      esac
      node /scripts/lib/reviewed-npm-archive.mts --verify-lock \
        --lock-sha256 "$migration_lock" --lockfile "$migration_root/package-lock.json" \
        --registry-origin https://registry.npmjs.org/ \
        --package-spec "openclaw@$migration_version" --integrity "$migration_integrity" \
        --tarball-url "https://registry.npmjs.org/openclaw/-/openclaw-$migration_version.tgz" \
        --label "OpenClaw migration $migration_version"
      npm --prefix "$migration_root" ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress \
        --userconfig /dev/null --registry https://registry.npmjs.org/
      node /scripts/lib/remediate-openclaw-runtime-dependencies.mts --prefix "$migration_root"
    done
    ;;
  materialize)
    set -eu
    for migration_version in 2026.9.5 2026.9.7; do
      migration_root="/usr/local/lib/nemoclaw/openclaw-migrations/$migration_version"
      case "$migration_version" in
        2026.9.5) migration_lock=b2864b729531e606de939b50d6b64001b1e97e0b17acf1e2f69c0a5792aa9c93 ;;
        2026.9.7) migration_lock=35020ee3d2638c8b5f784387085836c0d7fb62dfe1309097d53da235247197a5 ;;
      esac
      NPM_CONFIG_OFFLINE=true npm_config_offline=true \
        NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
        node "$migration_root/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs"
      node /scripts/lib/reviewed-npm-archive.mts --verify-installed-lock \
        --lock-sha256 "$migration_lock" --lockfile "$migration_root/package-lock.json" \
        --install-root "$migration_root" --label "OpenClaw migration $migration_version"
      node /scripts/lib/patch-openclaw-plugin-source-root.mts "$migration_root/node_modules/openclaw/dist"
      chown -R root:root "$migration_root"
      chmod -R a+rX,go-w "$migration_root"
    done
    ;;
  *)
    echo "Expected install or materialize" >&2
    exit 1
    ;;
esac
