#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Updates the pinned Hermes Agent release used by the nemohermes sandbox.
#
# For the selected GitHub release tag (default: latest) this script:
#   1. Downloads the release tarball from GitHub and computes its sha256.
#   2. Reads the package semver from the tarball's pyproject.toml
#      (calver tag -> semver mapping, e.g. v2026.6.19 -> 0.17.0).
#   3. Fetches the sha512 integrity of the matching hermes-agent npm
#      package via `npm view hermes-agent@<semver> dist.integrity`.
#   4. Rewrites the HERMES_VERSION / HERMES_SEMVER / HERMES_TARBALL_SHA256 /
#      HERMES_NPM_INTEGRITY ARGs (and the calver comment) in
#      agents/hermes/Dockerfile.base.
#   5. Rewrites expected_version in agents/hermes/manifest.yaml.
#   6. With --update-installed-copies, scans installer-managed locations
#      (~/.nemoclaw, ~/.hermes, and $NEMOCLAW_SOURCE_ROOT) for saved copies of
#      the Hermes Dockerfiles and manifests. `nemohermes onboard --resume` /
#      `rebuild` build from the installed clone (default ~/.nemoclaw/source),
#      not this checkout, so a stale copy there would silently rebuild the old
#      Hermes. Copies already pinned to the target release are left alone; stale
#      ones are re-pinned.
#
# With --build it then force-rebuilds the base image with --no-cache so the
# new tarball is actually downloaded instead of served from Docker layer
# cache of a previously pulled GHCR image. With --rebuild it additionally
# rebuilds the sandbox against the locally-built base image (via
# NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF) and verifies the running version.
# The override is pinned to an immutable image-ID-derived tag rather than a
# floating one: locally built images have no registry digest to pin by, and
# a moving tag could be remapped or rebuilt between build and rebuild.
#
# Usage:
#   scripts/update-hermes-agent.sh                  # pin latest GitHub release
#   scripts/update-hermes-agent.sh --tag v2026.6.19 # pin a specific calver tag
#   scripts/update-hermes-agent.sh --check          # exit 0 if up-to-date, 1 if stale
#   scripts/update-hermes-agent.sh --build          # also build the base image (no cache)
#   scripts/update-hermes-agent.sh --rebuild        # --build + sandbox rebuild + verify
#   scripts/update-hermes-agent.sh --update-installed-copies
#                                                   # also re-pin installed copies under ~/.nemoclaw / ~/.hermes
#
# Environment:
#   GITHUB_TOKEN           — optional, raises the GitHub API rate limit
#   HERMES_BASE_REF        — base image ref to build/use
#                            (default ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest)
#   NEMOCLAW_SOURCE_ROOT   — extra installed-source root to scan when
#                            --update-installed-copies is set

set -euo pipefail

GITHUB_REPO="NousResearch/hermes-agent"
NPM_PACKAGE="hermes-agent"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE_BASE="${REPO_ROOT}/agents/hermes/Dockerfile.base"
MANIFEST="${REPO_ROOT}/agents/hermes/manifest.yaml"
BASE_REF="${HERMES_BASE_REF:-ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest}"

CHECK_ONLY=0
DO_BUILD=0
DO_REBUILD=0
UPDATE_INSTALLED_COPIES=0
REQUESTED_TAG=""

usage() {
  sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^Usage:/,/^Environment:/p' | sed '$d' >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --build) DO_BUILD=1 ;;
    --rebuild)
      DO_BUILD=1
      DO_REBUILD=1
      UPDATE_INSTALLED_COPIES=1
      ;;
    --update-installed-copies) UPDATE_INSTALLED_COPIES=1 ;;
    --tag)
      [[ $# -ge 2 ]] || usage
      REQUESTED_TAG="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

for tool in curl python3 npm sha256sum tar sed realpath; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: required tool not found: $tool" >&2
    exit 1
  }
done

gh_api() {
  local url="$1"
  local -a auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  curl -fsSL --retry 3 --retry-delay 1 --retry-all-errors \
    --connect-timeout 10 --max-time 60 \
    -H "Accept: application/vnd.github+json" "${auth[@]}" "$url"
}

# ---------------------------------------------------------------------------
# Installed copies of the Hermes Dockerfiles/manifests.
# `nemohermes onboard --resume` and `rebuild` build from the installer-managed
# clone (default ~/.nemoclaw/source), not from this checkout, so any saved
# copy with stale pins would silently rebuild the previous Hermes release.
# ---------------------------------------------------------------------------
pinned_tag_of() {
  sed -n 's|^ARG HERMES_VERSION=||p' "$1" | head -1
}

file_link_count() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"
}

path_is_under_root() {
  local path_real="$1"
  local root_real="$2"
  [[ "$path_real" == "$root_real" || "$path_real" == "$root_real"/* ]]
}

safe_installed_dockerfile() {
  local root="$1"
  local file="$2"
  local root_real file_real checkout_real links
  if [[ -L "$root" ]]; then
    echo "SKIP unsafe installed-copy root ${root}: symlink roots are not rewritten" >&2
    return 1
  fi
  if [[ -L "$file" || ! -f "$file" ]]; then
    echo "SKIP unsafe installed copy ${file}: candidate is not a regular file" >&2
    return 1
  fi
  root_real="$(realpath "$root")" || return 1
  file_real="$(realpath "$file")" || return 1
  checkout_real="$(realpath "$DOCKERFILE_BASE")" || return 1
  if ! path_is_under_root "$file_real" "$root_real"; then
    echo "SKIP unsafe installed copy ${file}: resolved path escapes ${root}" >&2
    return 1
  fi
  if [[ "$file_real" == "$checkout_real" ]]; then
    echo "SKIP unsafe installed copy ${file}: aliases the current checkout Dockerfile" >&2
    return 1
  fi
  links="$(file_link_count "$file" 2>/dev/null || true)"
  if [[ "$links" != "1" ]]; then
    echo "SKIP unsafe installed copy ${file}: link count is ${links:-unknown}" >&2
    return 1
  fi
}

discover_installed_dockerfiles() {
  local -a roots=()
  [[ -n "${NEMOCLAW_SOURCE_ROOT:-}" ]] && roots+=("${NEMOCLAW_SOURCE_ROOT}")
  roots+=("${HOME}/.nemoclaw" "${HOME}/.hermes")
  local root file
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    if [[ -L "$root" ]]; then
      echo "SKIP unsafe installed-copy root ${root}: symlink roots are not rewritten" >&2
      continue
    fi
    find "$root" -maxdepth 6 \( -name node_modules -o -name .git \) -prune \
      -o \( -type f -o -type l \) -name 'Dockerfile*' -print 2>/dev/null \
      | while IFS= read -r file; do
        safe_installed_dockerfile "$root" "$file" || continue
        grep -q '^ARG HERMES_VERSION=' "$file" && printf '%s\n' "$file"
      done
  done \
    | sort -u
}

# Saved installed copies are only safe to rewrite when they already carry the
# current Hermes integration contract. A legacy source tree with fresh pins
# but stale Dockerfile/start/config code can rebuild an image that looks
# version-current while missing the v0.17 runtime hardening.
installed_copy_schema_error() {
  local dockerfile_base="$1"
  local dockerfile="${dockerfile_base%/Dockerfile.base}/Dockerfile"
  local -a missing=()
  local item joined

  for item in \
    "ARG HERMES_VERSION=" \
    "ARG HERMES_SEMVER=" \
    "ARG HERMES_TARBALL_SHA256=" \
    "ARG HERMES_NPM_INTEGRITY="; do
    grep -q "^${item}" "$dockerfile_base" || missing+=("${item%?}")
  done

  if [[ ! -f "$dockerfile" ]]; then
    missing+=("agents/hermes/Dockerfile")
  else
    for item in \
      "validate-hermes-env-secret-boundary.py" \
      "seed-hermes-dashboard-config.py" \
      "COPY agents/hermes/build-mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py" \
      "/opt/hermes/.venv/bin/python -I /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py --guard /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py" \
      "hermes-mcp-config-transaction.py" \
      "openshell-child-visible-credentials.v0.0.72.json" \
      "HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix" \
      "node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts" \
      "/sandbox/.hermes/dashboard-home"; do
      grep -Fq "$item" "$dockerfile" || missing+=("marker ${item}")
    done
    if grep -q '^ARG HERMES_SEMVER=' "$dockerfile"; then
      missing+=("final Dockerfile #5254 guard must derive Hermes version from installed hermes --version")
    fi
  fi

  if ((${#missing[@]} == 0)); then
    return 0
  fi

  joined=""
  for item in "${missing[@]}"; do
    [[ -z "$joined" ]] || joined+=", "
    joined+="$item"
  done
  printf '%s\n' "$joined"
  return 1
}

# Rewrite the version pins in a Hermes base Dockerfile. Callers that operate on
# installed copies must validate `installed_copy_schema_error` before mutation.
apply_dockerfile_pins() {
  local dockerfile="$1"
  sed -i.bak \
    -e "s|^# Calver tag v[0-9.]* = Hermes Agent v[0-9.]*\.$|# Calver tag ${TAG} = Hermes Agent v${SEMVER}.|" \
    -e "s|^ARG HERMES_VERSION=.*|ARG HERMES_VERSION=${TAG}|" \
    -e "s|^ARG HERMES_SEMVER=.*|ARG HERMES_SEMVER=${SEMVER}|" \
    -e "s|^ARG HERMES_TARBALL_SHA256=.*|ARG HERMES_TARBALL_SHA256=${TARBALL_SHA256}|" \
    -e "s|^ARG HERMES_NPM_INTEGRITY=.*|ARG HERMES_NPM_INTEGRITY=${NPM_INTEGRITY}|" \
    "$dockerfile"
  rm -f "${dockerfile}.bak"
  grep -q "^ARG HERMES_VERSION=${TAG}$" "$dockerfile" \
    && grep -q "^ARG HERMES_SEMVER=${SEMVER}$" "$dockerfile" \
    && grep -q "^ARG HERMES_TARBALL_SHA256=${TARBALL_SHA256}$" "$dockerfile" \
    && grep -q "^ARG HERMES_NPM_INTEGRITY=${NPM_INTEGRITY}$" "$dockerfile"
}

apply_manifest_pin() {
  local manifest="$1"
  sed -i.bak "s|^expected_version: \".*\"|expected_version: \"${SEMVER}\"|" "$manifest"
  rm -f "${manifest}.bak"
  grep -q "^expected_version: \"${SEMVER}\"$" "$manifest"
}

# ---------------------------------------------------------------------------
# Resolve target tag (calver, with leading v)
# ---------------------------------------------------------------------------
if [[ -n "$REQUESTED_TAG" ]]; then
  TAG="v${REQUESTED_TAG#v}"
else
  TAG=$(gh_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
fi
if ! [[ "$TAG" =~ ^v[0-9]+(\.[0-9]+)+$ ]]; then
  echo "ERROR: unexpected release tag format: ${TAG}" >&2
  exit 1
fi
CALVER="${TAG#v}"

# ---------------------------------------------------------------------------
# Read currently pinned values
# ---------------------------------------------------------------------------
current_arg() {
  sed -n "s|^ARG $1=||p" "$DOCKERFILE_BASE" | head -1
}

CURRENT_TAG="$(current_arg HERMES_VERSION)"
CURRENT_SEMVER="$(current_arg HERMES_SEMVER)"
CURRENT_MANIFEST_VERSION="$(sed -n 's|^expected_version: "\(.*\)"|\1|p' "$MANIFEST" | head -1)"

if [[ -z "$CURRENT_TAG" || -z "$CURRENT_SEMVER" || -z "$CURRENT_MANIFEST_VERSION" ]]; then
  echo "ERROR: could not read current pins from ${DOCKERFILE_BASE} / ${MANIFEST}" >&2
  exit 1
fi

if [[ "$CHECK_ONLY" == 1 ]]; then
  status=0
  if [[ "$CURRENT_TAG" != "$TAG" ]]; then
    echo "STALE: Dockerfile.base pins Hermes ${CURRENT_TAG}, target is ${TAG}."
    status=1
  else
    echo "OK: Dockerfile.base pins Hermes ${TAG}."
  fi
  if [[ "$CURRENT_MANIFEST_VERSION" != "$CURRENT_SEMVER" ]]; then
    echo "DRIFT: manifest expected_version (${CURRENT_MANIFEST_VERSION}) does not match Dockerfile.base HERMES_SEMVER (${CURRENT_SEMVER})."
    status=1
  fi
  if [[ "$UPDATE_INSTALLED_COPIES" == 1 ]]; then
    while IFS= read -r installed_df; do
      [[ -n "$installed_df" ]] || continue
      schema_error="$(installed_copy_schema_error "$installed_df")" || {
        echo "INVALID: installed copy ${installed_df} uses a legacy Hermes source schema (${schema_error}); refresh or reinstall the installed source before updating pins."
        status=1
        continue
      }
      installed_tag="$(pinned_tag_of "$installed_df")"
      if [[ "$installed_tag" == "$TAG" ]]; then
        echo "OK: installed copy ${installed_df} pins Hermes ${TAG}."
      else
        echo "STALE: installed copy ${installed_df} pins Hermes ${installed_tag} — onboard/rebuild would use it instead of the updated checkout."
        status=1
      fi
    done < <(discover_installed_dockerfiles)
  else
    echo "Installed-copy scan skipped; pass --update-installed-copies to check saved installer clones."
  fi
  [[ "$status" == 0 ]] || echo "To update, run: scripts/update-hermes-agent.sh"
  exit "$status"
fi

echo "Target Hermes release: ${TAG} (current: ${CURRENT_TAG})"

# ---------------------------------------------------------------------------
# Download tarball, compute sha256, read semver from pyproject.toml
# ---------------------------------------------------------------------------
WORKDIR_TMP="$(mktemp -d)"
trap 'rm -rf "$WORKDIR_TMP"' EXIT

TARBALL="${WORKDIR_TMP}/hermes-${TAG}.tar.gz"
TARBALL_URL="https://github.com/${GITHUB_REPO}/archive/refs/tags/${TAG}.tar.gz"
echo "Downloading ${TARBALL_URL}"
curl -fsSL --retry 3 --retry-delay 1 --retry-all-errors \
  --connect-timeout 10 --max-time 300 \
  -o "$TARBALL" "$TARBALL_URL"

TARBALL_SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
echo "Tarball sha256: ${TARBALL_SHA256}"

# GitHub archive tarballs root everything in a single <repo>-<calver>/
# directory; read the project version from its top-level pyproject.toml only
# (sub-packages may ship their own pyproject.toml files).
TARBALL_PREFIX="${GITHUB_REPO#*/}-${CALVER}"
SEMVER="$(tar -xzf "$TARBALL" -O "${TARBALL_PREFIX}/pyproject.toml" \
  | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)"
if ! [[ "$SEMVER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: could not read package semver from ${TARBALL_PREFIX}/pyproject.toml (got: '${SEMVER}')" >&2
  exit 1
fi
echo "Calver ${CALVER} maps to Hermes Agent semver ${SEMVER}"

# ---------------------------------------------------------------------------
# Fetch npm sha512 integrity for the matching package version
# ---------------------------------------------------------------------------
NPM_INTEGRITY="$(npm view "${NPM_PACKAGE}@${SEMVER}" dist.integrity 2>/dev/null || true)"
if ! [[ "$NPM_INTEGRITY" =~ ^sha512- ]]; then
  echo "ERROR: npm view ${NPM_PACKAGE}@${SEMVER} dist.integrity did not return a sha512 value (got: '${NPM_INTEGRITY}')." >&2
  echo "Hint: the npm release may lag the GitHub tag; check: npm view ${NPM_PACKAGE} versions" >&2
  exit 1
fi
echo "npm dist.integrity: ${NPM_INTEGRITY}"

# ---------------------------------------------------------------------------
# Rewrite agents/hermes/Dockerfile.base and agents/hermes/manifest.yaml
# ---------------------------------------------------------------------------
apply_dockerfile_pins "$DOCKERFILE_BASE" || {
  echo "ERROR: failed to update pins in ${DOCKERFILE_BASE}" >&2
  exit 1
}
apply_manifest_pin "$MANIFEST" || {
  echo "ERROR: failed to update expected_version in ${MANIFEST}" >&2
  exit 1
}

# Fail loudly if any pin did not land (e.g. an ARG was renamed). The repo
# checkout must carry all four pins, not just the two legacy ones.
for pair in \
  "HERMES_VERSION=${TAG}" \
  "HERMES_SEMVER=${SEMVER}" \
  "HERMES_TARBALL_SHA256=${TARBALL_SHA256}" \
  "HERMES_NPM_INTEGRITY=${NPM_INTEGRITY}"; do
  grep -q "^ARG ${pair}$" "$DOCKERFILE_BASE" || {
    echo "ERROR: failed to update ARG ${pair%%=*} in ${DOCKERFILE_BASE}" >&2
    exit 1
  }
done

echo ""
echo "Updated:"
echo "  ${DOCKERFILE_BASE#"${REPO_ROOT}"/}: HERMES_VERSION=${TAG}, HERMES_SEMVER=${SEMVER}"
echo "  ${MANIFEST#"${REPO_ROOT}"/}: expected_version=\"${SEMVER}\""

# ---------------------------------------------------------------------------
# Bring saved installed copies (~/.nemoclaw, ~/.hermes) along, so an
# onboard --resume / rebuild that builds from the installed clone does not
# silently use the previous release. Copies already pinned to the target
# release are left untouched.
# ---------------------------------------------------------------------------
if [[ "$UPDATE_INSTALLED_COPIES" == 1 ]]; then
  while IFS= read -r installed_df; do
    [[ -n "$installed_df" ]] || continue
    installed_tag="$(pinned_tag_of "$installed_df")"
    if [[ "$installed_tag" == "$TAG" ]]; then
      echo "  installed copy ${installed_df}: already pins ${TAG}, left as-is"
      continue
    fi
    schema_error="$(installed_copy_schema_error "$installed_df")" || {
      echo "ERROR: refusing to update legacy installed copy ${installed_df}: ${schema_error}. Refresh or reinstall the installed source, then re-run this script." >&2
      exit 1
    }
    apply_dockerfile_pins "$installed_df" || {
      echo "ERROR: failed to update pins in installed copy ${installed_df}" >&2
      exit 1
    }
    echo "  installed copy ${installed_df}: HERMES_VERSION ${installed_tag} -> ${TAG}"
    installed_manifest="$(dirname "$installed_df")/manifest.yaml"
    if [[ -f "$installed_manifest" ]] && grep -q '^expected_version: "' "$installed_manifest"; then
      apply_manifest_pin "$installed_manifest" || {
        echo "ERROR: failed to update expected_version in installed copy ${installed_manifest}" >&2
        exit 1
      }
      echo "  installed copy ${installed_manifest}: expected_version=\"${SEMVER}\""
    fi
  done < <(discover_installed_dockerfiles)
else
  echo "  installed copies: skipped (pass --update-installed-copies to scan and re-pin saved installer clones)"
fi

# ---------------------------------------------------------------------------
# Optional: build base image without cache, rebuild sandbox, verify
# ---------------------------------------------------------------------------
if [[ "$DO_BUILD" == 1 ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "ERROR: docker is required for --build/--rebuild" >&2
    exit 1
  }
  echo ""
  echo "Building ${BASE_REF} (--no-cache, so the new tarball is really fetched)…"
  docker build --no-cache -f "$DOCKERFILE_BASE" -t "$BASE_REF" "$REPO_ROOT"
fi

if [[ "$DO_REBUILD" == 1 ]]; then
  command -v nemohermes >/dev/null 2>&1 || {
    echo "ERROR: nemohermes is required for --rebuild" >&2
    exit 1
  }
  # Pin the override to an immutable, content-addressed tag derived from the
  # image ID. A plain tag (e.g. :latest) can be moved by a later build, and
  # locally built images have no registry digest to pin to — the ID-derived
  # tag guarantees the rebuild uses exactly the image built above.
  base_image_id="$(docker image inspect -f '{{.Id}}' "$BASE_REF")"
  base_image_id_hex="${base_image_id#sha256:}"
  pin_tag="nemoclaw-hermes-sandbox-base-local:image-${base_image_id_hex}"
  docker tag "$BASE_REF" "$pin_tag"
  echo ""
  echo "Rebuilding sandbox against ${pin_tag} (image ID ${base_image_id})…"
  NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF="$pin_tag" nemohermes hermes rebuild

  echo "Verifying running Hermes version…"
  # `sandbox exec` (not `connect`) is the one-shot passthrough: connect is a
  # strict, interactive shell that ignores a trailing `-- <cmd>`, so it would
  # just print its own usage. exec forwards everything after `--` to the
  # sandbox user and exits with the remote command's status.
  RUNNING="$(nemohermes hermes exec -- hermes --version 2>/dev/null || true)"
  if [[ "$RUNNING" == *"$SEMVER"* ]]; then
    echo "OK: sandbox reports Hermes Agent v${SEMVER} (${TAG})."
  else
    echo "ERROR: sandbox reports '${RUNNING:-<no output>}', expected v${SEMVER}." >&2
    echo "Hint: the rebuild may have used a cached/GHCR base image; re-run with --rebuild after" >&2
    echo "      checking the build log, or verify manually:" >&2
    echo "        nemohermes hermes exec -- hermes --version" >&2
    exit 1
  fi
elif [[ "$DO_BUILD" == 0 ]]; then
  echo ""
  echo "Next steps (not run automatically):"
  echo "  scripts/update-hermes-agent.sh --tag ${TAG} --build     # build base image without cache"
  echo "  scripts/update-hermes-agent.sh --tag ${TAG} --rebuild   # build + sandbox rebuild + verify"
  echo "  scripts/update-hermes-agent.sh --tag ${TAG} --update-installed-copies"
fi
