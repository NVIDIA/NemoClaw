// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only fault injection. It performs no system-drive or installation operation.
#[path = "../../host-preparation/diagnostics.rs"]
mod diagnostics;

fn main() {
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") {
        std::process::exit(2);
    }
    let destination = diagnostics::arguments(&std::env::args_os().skip(1).collect::<Vec<_>>())
        .expect("The Burn fixture requires its actual diagnostic arguments")
        .expect("The Burn fixture requires its diagnostic sidecar");
    let primary = Err("open-metadata-inspection-target: Win32 error 32".into());
    let outcome = diagnostics::Outcome::from_result(&primary).with_preparation_counts(None);
    let record = outcome.json(Some(&destination.attempt), 0);
    eprint!("{record}");
    if diagnostics::persist(&destination.path, &record).is_err() {
        eprintln!("The diagnostic fixture sidecar could not be saved.");
    }
    std::process::exit(outcome.exit_code());
}
