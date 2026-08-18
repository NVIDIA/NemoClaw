#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Install the exact OpenShell v0.0.106 Linux x86_64 release for the bounded
# qualification jobs that run before NemoClaw changes its supported 0.0.101 pin.

set -euo pipefail

fail() {
  printf 'OpenShell v0.0.106 qualification install failed: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "Linux is required"
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) fail "x86_64 is required" ;;
esac

for command_name in curl install mktemp sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

readonly release_tag="v0.0.106"
readonly release_base="https://github.com/NVIDIA/OpenShell/releases/download/${release_tag}"
readonly target_dir="/usr/local/bin"
readonly -a assets=(
  "openshell-x86_64-unknown-linux-musl.tar.gz"
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz"
  "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz"
)
readonly -a members=("openshell" "openshell-gateway" "openshell-sandbox")
readonly -a archive_sha256=(
  "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0"
  "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c"
  "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355"
)
readonly -a binary_sha256=(
  "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59"
  "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c"
  "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8"
)

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

for index in "${!assets[@]}"; do
  asset="${assets[$index]}"
  member="${members[$index]}"
  archive="${workspace}/${asset}"
  extracted="${workspace}/extracted-${index}"
  mkdir -p "$extracted"

  curl --proto '=https' --tlsv1.2 -fsSL \
    --connect-timeout 10 --max-time 120 --retry 3 --retry-all-errors \
    "${release_base}/${asset}" -o "$archive"
  printf '%s  %s\n' "${archive_sha256[$index]}" "$archive" | sha256sum -c -

  members_found="$(LC_ALL=C tar -tzf "$archive")"
  [[ "$members_found" == "$member" ]] \
    || fail "$asset must contain exactly one member named $member"
  member_detail="$(LC_ALL=C tar -tvzf "$archive")"
  [[ "$member_detail" != *$'\n'* && "${member_detail:0:1}" == "-" && "${member_detail##* }" == "$member" ]] \
    || fail "$asset member $member must be one regular file"

  tar -xzf "$archive" -C "$extracted"
  printf '%s  %s\n' "${binary_sha256[$index]}" "${extracted}/${member}" | sha256sum -c -
done

install_command=(install -m 755)
if [[ ! -w "$target_dir" ]]; then
  command -v sudo >/dev/null 2>&1 || fail "sudo is required to write $target_dir"
  install_command=(sudo install -m 755)
fi

for index in "${!members[@]}"; do
  member="${members[$index]}"
  "${install_command[@]}" "${workspace}/extracted-${index}/${member}" "${target_dir}/${member}"
  printf '%s  %s\n' "${binary_sha256[$index]}" "${target_dir}/${member}" | sha256sum -c -
done

"${target_dir}/openshell" --version | grep -Eq '(^|[^0-9])0\.0\.106([^0-9]|$)' \
  || fail "installed OpenShell CLI does not report 0.0.106"
