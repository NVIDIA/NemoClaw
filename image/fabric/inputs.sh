#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Record an agent image's build inputs.
#   lock DIRECTORY        Requirements pinning each locally compiled wheel in
#                         DIRECTORY to its exact bytes, for the same strict
#                         install as registry wheels.
#   provenance DIRECTORY  The inputs retained beside the image's executable code:
#                         the Fabric source, the requirements, and every file
#                         in DIRECTORY.
set -eu

hash() {
  sha256sum "$1" | cut -d ' ' -f 1
}

# The commit that a git archive, such as GitHub's source archives, records in
# its global header.
archive_commit() {
  python3 -c 'import sys, tarfile
archive = tarfile.open(sys.argv[1])
archive.next()
print(archive.pax_headers["comment"])' "$1"
}

case "${1:-}" in
  lock)
    names=
    found=
    for wheel in "$2"/*.whl; do
      [ -e "$wheel" ] || break
      found=1
      file=${wheel##*/}
      name=${file%%-*}
      rest=${file#*-}
      version=${rest%%-*}
      case " $names " in
        *" $name "*)
          echo "ambiguous locally compiled package: $name" >&2
          exit 1
          ;;
      esac
      names="$names $name"
      printf '%s==%s --hash=sha256:%s\n' "$(printf %s "$name" | tr _ -)" "$version" "$(hash "$wheel")"
    done
    if [ -z "$found" ]; then
      echo "no locally compiled wheels" >&2
      exit 1
    fi
    ;;
  provenance)
    revision=$(archive_commit /sources/fabric.tar.gz)
    printf '{"harness": "%s", "fabric_revision": "%s", "source_sha256": "%s", "requirements_sha256": "%s", "local_sources": {' \
      "$HARNESS" "$revision" "$(hash /sources/fabric.tar.gz)" "$(hash /requirements.txt)"
    cd "$2"
    separator=
    find . -type f | sed 's|^\./||' | LC_ALL=C sort > /tmp/inputs
    while read -r path; do
      printf '%s"%s": "%s"' "$separator" "$path" "$(hash "$path")"
      separator=', '
    done < /tmp/inputs
    rm /tmp/inputs
    printf '}}\n'
    ;;
  *)
    echo "usage: $0 lock DIRECTORY | provenance DIRECTORY" >&2
    exit 2
    ;;
esac
