// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use process_wrap::tokio::{CommandWrap, KillOnDrop};
use serde::Deserialize;

use crate::{CancellationToken, Error};

use super::{AccessGrant, PROFILE};

const RESULT_LIMIT: u64 = 4096;
const ENTRYPOINT: &str = "voiceclaw-nemoclaw-r0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub client_instructions: String,
}

/// Operator-approved VoiceClaw bootstrap installation.
#[derive(Clone, Debug)]
pub struct Bootstrap {
    executable: PathBuf,
}

impl Bootstrap {
    pub fn new(root: &Path) -> Result<Self, Error> {
        if !root.is_absolute() {
            return Err(Error::Configuration(crate::config::ConfigError(
                "VoiceClaw bootstrap path must be absolute",
            )));
        }
        let executable = root.join("bin").join(ENTRYPOINT);
        let metadata = fs::symlink_metadata(&executable).map_err(|_| {
            Error::Conflict("trusted VoiceClaw bootstrap executable is unavailable; agent retained")
        })?;
        if !metadata.file_type().is_file() {
            return Err(Error::Conflict(
                "trusted VoiceClaw bootstrap executable is invalid; agent retained",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(Error::Conflict(
                    "trusted VoiceClaw bootstrap executable is not executable; agent retained",
                ));
            }
        }
        Ok(Self { executable })
    }

    pub async fn prepare(
        &self,
        state_directory: &Path,
        cancel: &CancellationToken,
    ) -> Result<Prepared, Error> {
        let exchange = private_exchange(state_directory)?;
        let result = exchange.path().join("result.json");
        let args = [
            "prepare",
            "--profile",
            PROFILE,
            "--result-file",
            result
                .to_str()
                .ok_or(Error::State("VoiceClaw result path is invalid"))?,
        ];
        run(&self.executable, &args, Stdio::inherit(), cancel).await?;
        let value: PrepareResult = read_result(&result)?;
        if value.profile != PROFILE || value.status != "prepared" {
            return Err(Error::Conflict(
                "VoiceClaw preparation result is invalid; agent retained",
            ));
        }
        Ok(Prepared)
    }

    pub async fn connect(
        &self,
        state_directory: &Path,
        endpoint: &str,
        grant: &AccessGrant,
        cancel: &CancellationToken,
    ) -> Result<Ready, Error> {
        let exchange = private_exchange(state_directory)?;
        let result = exchange.path().join("result.json");
        let credential_path = exchange.path().join("credential");
        write_credential(&credential_path, grant.credential())?;
        let credential = File::open(&credential_path)
            .map_err(|_| Error::State("cannot open protected VoiceClaw credential"))?;
        let args = [
            "connect",
            "--profile",
            PROFILE,
            "--endpoint",
            endpoint,
            "--target-ref",
            grant.target_ref(),
            "--credential-fd",
            "0",
            "--result-file",
            result
                .to_str()
                .ok_or(Error::State("VoiceClaw result path is invalid"))?,
        ];
        let launched = run_started(&self.executable, &args, Stdio::from(credential), cancel);
        let mut child = match launched {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_file(&credential_path);
                return Err(error);
            }
        };
        fs::remove_file(&credential_path)
            .map_err(|_| Error::State("cannot unlink handed-off VoiceClaw credential"))?;
        wait(child.as_mut(), "connect", cancel).await?;
        let value: ConnectResult = read_result(&result)?;
        if value.profile != PROFILE
            || value.status != "ready"
            || value.target_ref != grant.target_ref()
            || value.client_instructions.is_empty()
            || value.client_instructions.len() > RESULT_LIMIT as usize
            || value.client_instructions.contains(grant.credential())
        {
            return Err(Error::Conflict(
                "VoiceClaw connection result is invalid; agent retained",
            ));
        }
        Ok(Ready {
            client_instructions: value.client_instructions,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareResult {
    profile: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConnectResult {
    profile: String,
    status: String,
    target_ref: String,
    client_instructions: String,
}

fn private_exchange(state_directory: &Path) -> Result<tempfile::TempDir, Error> {
    fs::create_dir_all(state_directory)
        .map_err(|_| Error::State("cannot prepare VoiceClaw exchange directory"))?;
    tempfile::Builder::new()
        .prefix("voiceclaw-r0-")
        .tempdir_in(state_directory)
        .map_err(|_| Error::State("cannot create private VoiceClaw exchange directory"))
}

fn write_credential(path: &Path, credential: &str) -> Result<(), Error> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| Error::State("cannot create protected VoiceClaw credential"))?;
    file.write_all(credential.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|_| Error::State("cannot write protected VoiceClaw credential"))?;
    file.sync_all()
        .map_err(|_| Error::State("cannot finish protected VoiceClaw credential"))
}

fn read_result<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, Error> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| Error::Conflict("VoiceClaw result is missing; agent retained"))?;
    if !before.file_type().is_file() || before.len() > RESULT_LIMIT {
        return Err(Error::Conflict(
            "VoiceClaw result is invalid; agent retained",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if before.permissions().mode() & 0o777 != 0o600 {
            return Err(Error::Conflict(
                "VoiceClaw result permissions are invalid; agent retained",
            ));
        }
    }
    let file = File::open(path)
        .map_err(|_| Error::Conflict("VoiceClaw result cannot be opened; agent retained"))?;
    let after = file
        .metadata()
        .map_err(|_| Error::Conflict("VoiceClaw result cannot be inspected; agent retained"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(Error::Conflict(
                "VoiceClaw result changed during inspection; agent retained",
            ));
        }
    }
    serde_json::from_reader(file)
        .map_err(|_| Error::Conflict("VoiceClaw result JSON is invalid; agent retained"))
}

async fn run(
    executable: &Path,
    args: &[&str],
    stdin: Stdio,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let mut child = run_started(executable, args, stdin, cancel)?;
    wait(child.as_mut(), args[0], cancel).await
}

fn run_started(
    executable: &Path,
    args: &[&str],
    stdin: Stdio,
    cancel: &CancellationToken,
) -> Result<Box<dyn process_wrap::tokio::ChildWrapper>, Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut command = CommandWrap::with_new(executable, |command| {
        command
            .args(args)
            .stdin(stdin)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    });
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    command.spawn().map_err(|_| {
        Error::Conflict("trusted VoiceClaw bootstrap could not be launched; agent retained")
    })
}

async fn wait(
    child: &mut dyn process_wrap::tokio::ChildWrapper,
    stage: &str,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let status = tokio::select! {
        status = tokio::time::timeout(Duration::from_secs(10 * 60), child.wait()) => {
            status.map_err(|_| Error::Conflict("VoiceClaw bootstrap timed out; agent retained"))?
        }
        () = cancel.cancelled() => {
            #[cfg(unix)] { let _ = child.signal(2); }
            #[cfg(windows)] { let _ = child.start_kill(); }
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            let _ = child.start_kill();
            return Err(Error::Cancelled);
        }
    };
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else if stage == "prepare" {
        Err(Error::Conflict(
            "VoiceClaw preparation failed; agent retained",
        ))
    } else {
        Err(Error::Conflict(
            "VoiceClaw connection failed; agent retained",
        ))
    }
}
