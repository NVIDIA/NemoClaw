#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Record one pushed platform image's SBOM in the CI package, under that
# platform's manifest digest, unless the package already has it.
#
#   image-sbom.sh IMAGE PUSHED PLATFORM
#
# IMAGE is the image to scan, local if Docker has it and otherwise read from
# the registry; PUSHED is its reference in the CI package; PLATFORM is
# linux/ARCH. SYFT names the pinned Syft, and PACKAGE the CI package.
set -eu
image=$1
pushed=$2
platform=$3
os=${platform%/*}
arch=${platform#*/}

# The release lists platform manifests, so key the SBOM by that digest.
digest=$(docker buildx imagetools inspect "$pushed" --raw |
  jq -r --arg os "$os" --arg arch "$arch" \
    '[.manifests[]? | select(.platform.os == $os and .platform.architecture == $arch) | .digest][0] // empty')
if [ -z "$digest" ]; then
  digest=$(docker buildx imagetools inspect "$pushed" --format '{{.Manifest.Digest}}')
fi
recorded="$PACKAGE:sbom-${digest#sha256:}"
if docker buildx imagetools inspect "$recorded" > /dev/null 2>&1; then
  echo "$recorded already records $pushed"
  exit 0
fi

if docker image inspect "$image" > /dev/null 2>&1; then
  source="docker:$image"
else
  source="registry:${pushed%:*}@$digest"
fi
dir=$(mktemp -d)
SYFT_CHECK_FOR_APP_UPDATE=false "$SYFT" "$source" \
  --select-catalogers +rust-cargo-lock-cataloger -q -o "spdx-json=$dir/sbom.spdx.json"
printf 'FROM scratch\nCOPY sbom.spdx.json /\n' > "$dir/Dockerfile"
docker build -q -t "$recorded" "$dir" > /dev/null
docker push --quiet "$recorded" > /dev/null
rm -rf "$dir"
echo "$recorded records $pushed"
