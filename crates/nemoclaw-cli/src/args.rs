// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "nemoclaw",
    version,
    about = "Manage an agent deployment from desired state"
)]
pub(crate) struct Cli {
    /// Directory containing deployment state and durable identities.
    #[arg(long, global = true, default_value = ".nemoclaw")]
    pub(crate) state_dir: PathBuf,
    /// Verified runtime bundle (defaults to the installed bundle).
    #[arg(long = "bundle", alias = "bundle-dir", global = true)]
    pub(crate) bundle_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub(crate) command: Command,
}
#[derive(Subcommand)]
pub(crate) enum Command {
    /// Preview configuration changes without changing runtime resources.
    #[command(after_help = "Examples:\n  nemoclaw plan spark.yaml\n  nemoclaw plan --destroy")]
    Plan {
        #[arg(long, conflicts_with = "file")]
        destroy: bool,
        /// Desired-state YAML path, or - to read standard input.
        #[arg(value_name = "FILE", required_unless_present = "destroy")]
        file: Option<PathBuf>,
    },
    /// Apply a configuration read from a file or standard input.
    #[command(
        after_help = "Examples:\n  nemoclaw apply spark.yaml\n  cat spark.yaml | nemoclaw apply -"
    )]
    Apply {
        /// Desired-state YAML path, or - to read standard input.
        #[arg(value_name = "FILE")]
        file: PathBuf,
    },
    /// Export observed configuration without secret values.
    #[command(after_help = "Examples:\n  nemoclaw export --output spark.yaml\n  nemoclaw export")]
    Export {
        /// Write YAML to this file instead of standard output.
        #[arg(short, long, value_name = "FILE")]
        output: Option<PathBuf>,
    },
    /// Remove owned workloads while retaining persistent data.
    Destroy,
}
#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, error::ErrorKind};

    #[test]
    fn command_definitions_are_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn input_is_explicit_and_destroy_preview_excludes_it() {
        for command in ["plan", "apply"] {
            for input in ["spark.yaml", "-"] {
                assert!(Cli::try_parse_from(["nemoclaw", command, input]).is_ok());
            }
            assert_eq!(
                Cli::try_parse_from(["nemoclaw", command])
                    .err()
                    .unwrap()
                    .kind(),
                ErrorKind::MissingRequiredArgument
            );
            assert!(Cli::try_parse_from(["nemoclaw", command, "--file", "spark.yaml"]).is_err());
        }
        assert!(Cli::try_parse_from(["nemoclaw", "plan", "--destroy"]).is_ok());
        assert!(Cli::try_parse_from(["nemoclaw", "plan", "--destroy", "spark.yaml"]).is_err());
    }

    #[test]
    fn export_accepts_an_output_path() {
        assert!(Cli::try_parse_from(["nemoclaw", "export", "--output", "spark.yaml"]).is_ok());
    }
}
