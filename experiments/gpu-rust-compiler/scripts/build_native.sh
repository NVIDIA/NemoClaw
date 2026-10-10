#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu
lab_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo build --locked --release --manifest-path "$lab_dir/compiler/Cargo.toml" --target-dir "$lab_dir/.build/compiler"
printf 'Built %s\n' "$lab_dir/.build/compiler/release/gpu-rust-compiler"
