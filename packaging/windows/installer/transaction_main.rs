// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "../launcher/src/runtime_lease.rs"]
mod runtime_lease;
mod runtime_manifest;
mod runtime_transaction;
#[cfg(windows)]
mod windows_runtime_store;
#[cfg(windows)]
mod windows_sha256;

fn failure_exit_code(error: &str) -> i32 {
    match error {
        "Identity" => 81,
        "NoTransaction" => 82,
        "ForeignTransaction" => 83,
        "LegacyRequiresStopFirst" => 84,
        "Busy" => 85,
        "Native(\"runtime-image-system-root\")" => 111,
        "Native(\"runtime-image-script\")" => 112,
        "Native(\"runtime-image-diskpart\")" => 113,
        "Native(\"runtime-image-script-cleanup\")" => 114,
        "Native(\"runtime-image-mount\")" => 115,
        "Native(\"runtime-image-detach\")" => 116,
        _ => 120,
    }
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("The native MSI transaction helper requires Windows.");
        std::process::exit(1);
    }
    #[cfg(windows)]
    {
        let arguments = std::env::args().skip(1).collect::<Vec<_>>();
        #[cfg(feature = "msi-boundary-fixture")]
        if arguments == ["--fixture-identify"] {
            println!("NEMOCLAW_MSI_FIXTURE_COMMIT_FAILURE_V1");
            return;
        }
        #[cfg(feature = "msi-boundary-fixture")]
        let (arguments, fail_before_admission) = {
            let mut arguments = arguments;
            let selected = arguments
                .last()
                .is_some_and(|value| value == "--fixture-fail-before-admission");
            if selected {
                arguments.pop();
            }
            (arguments, selected)
        };
        let args = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        // The same exact native lease entrypoints let Windows integration tests
        // hold real package/version/Node leases against the embedded helper.
        let result = match args.as_slice() {
            ["--runtime-session", agent] => runtime_lease::run(agent),
            ["--runtime-current-descriptor"] => runtime_lease::describe(),
            ["--runtime-retire", id, digest] => runtime_lease::transition(id, digest, false),
            ["--runtime-restore", id, digest] => runtime_lease::transition(id, digest, true),
            ["--runtime-msi", ..] => {
                let mut store = windows_runtime_store::WindowsStore::new();
                #[cfg(feature = "msi-boundary-fixture")]
                {
                    store.fail_before_admission = fail_before_admission;
                }
                runtime_transaction::dispatch(&mut store, &arguments[1..])
                    .map_err(|error| format!("{error:?}"))
            }
            _ => Err("The native MSI transaction command is invalid.".into()),
        };
        if let Err(error) = result {
            eprintln!("NemoClaw runtime maintenance failed: {error}");
            #[cfg(feature = "msi-boundary-fixture")]
            if error == "Native(\"fixture-before-admission\")" {
                std::process::exit(47);
            }
            // Windows Installer retains the actual custom-action exit code even
            // when Burn cannot preserve a child process's stderr. Keep these
            // codes stable so an early image attach/verification failure remains
            // attributable in the installed acceptance evidence.
            std::process::exit(failure_exit_code(&error));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::failure_exit_code;

    #[test]
    fn image_failures_have_stable_distinct_codes() {
        assert_eq!(failure_exit_code("Native(\"runtime-image-diskpart\")"), 113);
        assert_eq!(failure_exit_code("Native(\"runtime-image-mount\")"), 115);
        assert_eq!(failure_exit_code("Native(\"runtime-image-detach\")"), 116);
        assert_eq!(failure_exit_code("Native(\"other\")"), 120);
    }
}
