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
    /// Report operation timings on standard error.
    #[arg(long, short, global = true)]
    pub(crate) verbose: bool,
    #[command(subcommand)]
    pub(crate) command: Command,
}
#[derive(Subcommand)]
pub(crate) enum Command {
    /// Author and publish desired-state YAML without deploying it.
    #[command(after_help = "Example:\n  nemoclaw onboard --generate-only --output deployment.yaml")]
    Onboard {
        /// Generate configuration and stop before plan or apply.
        #[arg(long, required = true)]
        generate_only: bool,
        /// Write the generated YAML to this explicit path.
        #[arg(short, long, value_name = "FILE")]
        output: PathBuf,
        /// Use flags and defaults instead of prompting.
        #[arg(long, conflicts_with = "edit")]
        non_interactive: bool,
        /// Review and semantically edit an existing generated YAML document.
        #[arg(
            long,
            value_name = "FILE",
            conflicts_with_all = ["name", "sandbox", "agent", "provider", "model", "credential_env"]
        )]
        edit: Option<PathBuf>,
        /// Deployment name.
        #[arg(long)]
        name: Option<String>,
        /// Sandbox name.
        #[arg(long)]
        sandbox: Option<String>,
        /// Agent name.
        #[arg(long)]
        agent: Option<String>,
        /// Inference provider name.
        #[arg(long)]
        provider: Option<String>,
        /// Hosted NVIDIA model identifier.
        #[arg(long)]
        model: Option<String>,
        /// Environment variable that will provide the inference credential.
        #[arg(long)]
        credential_env: Option<String>,
    },
    /// Preview configuration changes without changing runtime resources.
    #[command(after_help = "Examples:\n  nemoclaw plan spark.yaml\n  nemoclaw plan --destroy")]
    Plan {
        /// Preview removal of owned workloads while retaining persistent data.
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
    #[test]
    fn onboard_requires_generation_mode_and_an_output_path() {
        assert!(
            Cli::try_parse_from([
                "nemoclaw",
                "onboard",
                "--generate-only",
                "--output",
                "deployment.yaml",
                "--non-interactive",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "nemoclaw",
                "onboard",
                "--generate-only",
                "--output",
                "deployment.yaml",
                "--edit",
                "deployment.yaml",
            ])
            .is_ok()
        );
        assert!(Cli::try_parse_from(["nemoclaw", "onboard", "--output", "x.yaml"]).is_err());
        assert!(Cli::try_parse_from(["nemoclaw", "onboard", "--generate-only"]).is_err());
    }
    #[test]
    fn help_explains_inputs_outputs_and_safety_contracts() {
        for (command, expected) in [
            (
                "plan",
                vec![
                    "without changing runtime resources",
                    "nemoclaw plan --destroy",
                ],
            ),
            (
                "apply",
                vec!["nemoclaw apply spark.yaml", "nemoclaw apply -"],
            ),
            ("export", vec!["without secret values", "--output"]),
            ("onboard", vec!["without deploying", "--generate-only"]),
            ("destroy", vec!["retaining persistent data"]),
        ] {
            let error = Cli::try_parse_from(["nemoclaw", command, "--help"])
                .err()
                .unwrap();
            assert_eq!(error.kind(), ErrorKind::DisplayHelp);
            for text in expected {
                assert!(error.to_string().contains(text));
            }
        }
        assert!(Cli::try_parse_from(["nemoclaw", "config", "apply"]).is_err());
    }

    #[test]
    fn deployment_options_work_before_and_after_subcommands() {
        for argv in [
            vec![
                "nemoclaw",
                "--state-dir",
                "state",
                "--bundle",
                "bundle",
                "apply",
                "spark.yaml",
            ],
            vec![
                "nemoclaw",
                "apply",
                "spark.yaml",
                "--state-dir",
                "state",
                "--bundle",
                "bundle",
            ],
        ] {
            let cli = Cli::try_parse_from(argv).unwrap();
            assert_eq!(cli.state_dir, PathBuf::from("state"));
            assert_eq!(cli.bundle_dir, Some(PathBuf::from("bundle")));
        }
    }
}
