#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -eu
cd "$(dirname "$0")"
printf '%s\n' "$*" >> calls
failure=$(cat failure)
case "$1" in
  buildx)
    [ "$failure" != build ] || exit 1
    while [ "$1" != --metadata-file ]; do shift; done
    if [ "$failure" = metadata ]; then printf '{}' > "$2"; else cp metadata.json "$2"; fi
    ;;
  load) [ "$failure" != load ] ;;
  image)
    case "$5" in
      fixture:test)
        if [ "$failure" = digest ]; then printf '{"Id":"image","RepoDigests":[],"Os":"linux","Architecture":"arm64"}'; else cat tag.json; fi
        ;;
      fixture@sha256:*) cat digest.json ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
