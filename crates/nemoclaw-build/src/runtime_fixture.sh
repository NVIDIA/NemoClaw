# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -eu
test "$(cat input)" = 'retained source'
test "$1 $2 $3 $4 $5" = 'build --locked --offline --release --target'
test "$7 $8" = '-p nemoclaw-runtime'
test "$GIT_CEILING_DIRECTORIES" = "$PWD"
test "$RUSTFLAGS" = "--remap-path-prefix=$PWD=/workspace"
test "$CFLAGS" = "-ffile-prefix-map=$PWD=/workspace"
test "$CXXFLAGS" = "$CFLAGS"
mkdir -p "$CARGO_TARGET_DIR/$6/release"
printf '%s' "$6" > "$CARGO_TARGET_DIR/$6/release/nemoclaw-runtime"
