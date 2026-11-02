#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Reviewed-archive invariants (#5896): committed archive SRI, exact registry
# metadata, packed-byte SRI, offline installation, official trust, and cleanup.
# Verify the mounted archive before installing its exact npm spec from the
# reviewed offline cache. OpenClaw requires registry provenance for official
# plugins; npm-pack records a source path and cannot retain official trust.
set -eu
export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives
optional_install_cache=
packed_plugin_archive=
trap 'if [ -n "$packed_plugin_archive" ]; then rm -rf "$(dirname "$packed_plugin_archive")"; fi; if [ -n "$optional_install_cache" ]; then rm -rf "$optional_install_cache"; fi' EXIT
prepare_optional_plugin_cache() {
  if [ -n "$optional_install_cache" ]; then return; fi
  unsafe_cache_entry="$(find -L /opt/nemoclaw-managed-messaging-npm-cache \( ! -user root -o -perm -020 -o -perm -002 \) -print -quit)"
  if [ -n "$unsafe_cache_entry" ]; then
    echo "ERROR: trusted optional plugin cache is not root-owned or is group/world writable" >&2
    exit 1
  fi
  optional_install_cache="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-optional-npm-cache.XXXXXX")"
  cp -R /opt/nemoclaw-managed-messaging-npm-cache/. "$optional_install_cache"/
  chmod -R u+rwX,go-w "$optional_install_cache"
  export NPM_CONFIG_CACHE="$optional_install_cache" NPM_CONFIG_OFFLINE=true npm_config_offline=true
  export NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
}
managed_image_union="${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION:-0}"
install_reviewed_openclaw_plugin() {
  plugin_spec="${1}@${OPENCLAW_VERSION}"
  case "$plugin_spec" in
    "@openclaw/diagnostics-otel@2026.10.5") expected_integrity="$OPENCLAW_DIAGNOSTICS_OTEL_2026_10_5_INTEGRITY" ;;
    "@openclaw/brave-plugin@2026.10.5") expected_integrity="$OPENCLAW_BRAVE_PLUGIN_2026_10_5_INTEGRITY" ;;
    "@openclaw/tavily-plugin@2026.10.5") expected_integrity="$OPENCLAW_TAVILY_PLUGIN_2026_10_5_INTEGRITY" ;;
    *)
      echo "ERROR: OpenClaw plugin ${plugin_spec} has no committed npm integrity pin" >&2
      exit 1
      ;;
  esac
  archive_name="${1#@openclaw/}-${OPENCLAW_VERSION}.tgz"
  expected_tarball="https://registry.npmjs.org/$1/-/${archive_name}"
  if [ -n "${NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:-}" ]; then
    plugin_archive="$NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR/$archive_name"
    # The template expression belongs to JavaScript.
    # shellcheck disable=SC2016
    node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const actual="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"); if(actual!==process.argv[2]) { console.error(`integrity mismatch for ${process.argv[1]}`); process.exit(1); }' \
      "$plugin_archive" "$expected_integrity"
  fi
  prepare_optional_plugin_cache
  packed_plugin_archive="$(
    NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true node /scripts/lib/reviewed-npm-archive.mts \
      --package-spec "$plugin_spec" --integrity "$expected_integrity" \
      --tarball-url "$expected_tarball" --label "OpenClaw plugin ${plugin_spec}"
  )"
  plugin_id="${1#@openclaw/}"
  plugin_id="${plugin_id%-plugin}"
  # A managed image installs capabilities without activating unused providers.
  set --
  if [ "$managed_image_union" = "1" ]; then set -- --no-enable; fi
  NPM_CONFIG_OFFLINE=true NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
    openclaw plugins install --force --accept-capabilities "$@" "$plugin_spec"
  node /scripts/lib/verify-openclaw-official-plugin.mts "$plugin_id" "$plugin_spec" "$expected_integrity"
  rm -rf "$(dirname "$packed_plugin_archive")"
  packed_plugin_archive=
}
if [ "$managed_image_union" = "1" ] || [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ] || [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then
  test -n "$OPENCLAW_VERSION"
fi
if [ "$managed_image_union" = "1" ]; then
  install_reviewed_openclaw_plugin "@openclaw/diagnostics-otel"
  install_reviewed_openclaw_plugin "@openclaw/brave-plugin"
  install_reviewed_openclaw_plugin "@openclaw/tavily-plugin"
elif [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then
  install_reviewed_openclaw_plugin "@openclaw/diagnostics-otel"
fi
if [ "$managed_image_union" != "1" ] && [ "$NEMOCLAW_WEB_SEARCH_ENABLED" = "1" ]; then
  case "${NEMOCLAW_WEB_SEARCH_PROVIDER:-brave}" in
    brave)
      install_reviewed_openclaw_plugin "@openclaw/brave-plugin"
      BRAVE_API_KEY=openshell:resolve:env:BRAVE_API_KEY openclaw doctor --fix --non-interactive
      ;;
    tavily)
      install_reviewed_openclaw_plugin "@openclaw/tavily-plugin"
      TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY openclaw doctor --fix --non-interactive
      ;;
    *)
      echo "ERROR: unsupported web-search provider: $NEMOCLAW_WEB_SEARCH_PROVIDER" >&2
      exit 1
      ;;
  esac
elif [ "$NEMOCLAW_OPENCLAW_OTEL" = "1" ]; then
  openclaw doctor --fix --non-interactive
fi
if [ -n "$optional_install_cache" ]; then
  rm -rf "$optional_install_cache"
  test ! -e "$optional_install_cache"
fi
trap - EXIT
