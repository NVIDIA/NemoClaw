// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Runs every oath that `varar.config.json` selects, one test per example.
//! Set `VARAR_UPDATE=1` to accept drift into `varar.lock.json`.

fn main() {
    varar_cargotest::run(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        nemoclaw_oaths::build_registry,
        nemoclaw_oaths::context_value,
    );
}
