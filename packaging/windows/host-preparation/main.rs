// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(any(test, all(windows, target_arch = "aarch64")))]
mod metadata_acl;
#[cfg(all(windows, target_arch = "aarch64"))]
mod windows_metadata;

fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["prepare-system-drive"] {
        eprintln!("Only fixed system-drive metadata preparation is supported.");
        std::process::exit(2);
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    if let Err(error) = windows_metadata::prepare_system_drive() {
        eprintln!("NemoClaw system-drive metadata preparation failed: {error}");
        std::process::exit(1);
    }
    #[cfg(not(all(windows, target_arch = "aarch64")))]
    {
        eprintln!("The metadata helper requires native Windows ARM64.");
        std::process::exit(2);
    }
}
