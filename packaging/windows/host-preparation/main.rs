// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod diagnostics;
#[cfg(any(test, all(windows, target_arch = "aarch64")))]
mod metadata_acl;
#[cfg(all(windows, target_arch = "aarch64"))]
mod windows_metadata;

fn main() {
    let destination = match diagnostics::arguments(&std::env::args_os().skip(1).collect::<Vec<_>>())
    {
        Ok(destination) => destination,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let started = std::time::Instant::now();
    #[cfg(all(windows, target_arch = "aarch64"))]
    let result = windows_metadata::prepare_system_drive();
    #[cfg(not(all(windows, target_arch = "aarch64")))]
    let result = Err("The metadata helper requires native Windows ARM64.".into());
    let outcome = diagnostics::Outcome::from_result(&result);
    let record = outcome.json(
        destination.as_ref().map(|value| value.attempt.as_str()),
        started.elapsed().as_millis(),
    );
    if outcome.failed {
        eprint!("{record}");
    }
    if let Some(destination) = destination {
        if let Err(error) = diagnostics::persist(&destination.path, &record) {
            // Logging must not replace the primary preparation result or expose
            // caller paths. The same structured failure remains on stderr.
            eprintln!(
                "NemoClaw preparation diagnostic could not be saved (OS code {}).",
                error.raw_os_error().unwrap_or(0)
            );
        }
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    let exit_code = outcome.exit_code();
    #[cfg(not(all(windows, target_arch = "aarch64")))]
    let exit_code = 2;
    std::process::exit(exit_code);
}
