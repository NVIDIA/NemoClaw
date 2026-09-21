// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{CancellationToken, Error, config::Document};
use std::{fs::File, io::Write, path::Path};
use tokio::io::{AsyncRead, AsyncReadExt};

#[cfg(unix)]
/// Read a terminal through OS readiness so cancellation does not leave Tokio's
/// blocking stdin worker waiting after SIGINT or SIGTERM.
pub(crate) struct TerminalInput {
    input: tokio::io::unix::AsyncFd<File>,
    original_flags: rustix::fs::OFlags,
}

#[cfg(unix)]
impl TerminalInput {
    pub(crate) fn open() -> std::io::Result<Self> {
        let input = File::open("/dev/stdin")?;
        let original_flags = rustix::fs::fcntl_getfl(&input)?;
        let input = tokio::io::unix::AsyncFd::new(input)?;
        rustix::fs::fcntl_setfl(
            input.get_ref(),
            original_flags | rustix::fs::OFlags::NONBLOCK,
        )?;
        Ok(Self {
            input,
            original_flags,
        })
    }
}

#[cfg(unix)]
impl Drop for TerminalInput {
    fn drop(&mut self) {
        let _ = rustix::fs::fcntl_setfl(self.input.get_ref(), self.original_flags);
    }
}

#[cfg(unix)]
impl AsyncRead for TerminalInput {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        loop {
            let mut ready = std::task::ready!(self.input.poll_read_ready_mut(context))?;
            match ready.try_io(|input| {
                let unfilled = buffer.initialize_unfilled();
                let mut file = input.get_ref();
                let read = std::io::Read::read(&mut file, unfilled)?;
                buffer.advance(read);
                Ok(())
            }) {
                Ok(result) => return std::task::Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }
}

pub(crate) async fn document<R: AsyncRead + Unpin>(
    file: &Path,
    stdin: R,
    cancel: &CancellationToken,
) -> Result<Document, Box<dyn std::error::Error>> {
    if file != Path::new("-") {
        let input = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(Error::Cancelled.into()),
            result = tokio::fs::File::open(file) => result?,
        };
        return read_document(input, cancel).await;
    }
    read_document(stdin, cancel).await
}

async fn read_document<R: AsyncRead + Unpin>(
    input: R,
    cancel: &CancellationToken,
) -> Result<Document, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let mut input = input.take(nemoclaw_sdk::config::MAX_DOCUMENT_BYTES + 1);
    tokio::select! {biased; ()=cancel.cancelled()=>return Err(Error::Cancelled.into()),result=input.read_to_end(&mut bytes)=>{result?;}}
    Ok(Document::parse(bytes.as_slice())?)
}
pub(crate) fn write_output(
    path: Option<&Path>,
    bytes: &[u8],
    mut stdout: impl Write,
) -> std::io::Result<()> {
    match path {
        Some(path) => write_path(path, bytes, File::sync_all),
        None => stdout.write_all(bytes),
    }
}

fn write_path(
    path: &Path,
    bytes: &[u8],
    sync_file: impl FnOnce(&File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    sync_file(temporary.as_file())?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    const YAML: &[u8] = include_bytes!("../../../examples/spark/remote-vllm.yaml");

    #[tokio::test]
    async fn file_and_explicit_stdin_read_the_same_document() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input.yaml");
        std::fs::write(&path, YAML).unwrap();
        let cancel = CancellationToken::new();
        let file = document(&path, tokio::io::empty(), &cancel).await.unwrap();
        let stdin = document(Path::new("-"), YAML, &cancel).await.unwrap();
        assert_eq!(file.yaml().unwrap(), stdin.yaml().unwrap());
    }

    #[tokio::test]
    async fn cancellation_prevents_input_access() {
        let directory = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        for path in [directory.path().join("missing.yaml"), "-".into()] {
            let error = document(&path, tokio::io::empty(), &cancel)
                .await
                .err()
                .unwrap();
            assert!(matches!(
                error.downcast_ref::<Error>(),
                Some(Error::Cancelled)
            ));
        }
    }

    #[tokio::test]
    async fn oversized_input_is_bounded_and_rejected() {
        let limit = nemoclaw_sdk::config::MAX_DOCUMENT_BYTES;
        let mut input = Cursor::new(vec![b' '; (limit + 100) as usize]);
        assert!(
            read_document(&mut input, &CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(input.position(), limit + 1);
    }

    #[tokio::test]
    async fn read_errors_and_malformed_yaml_are_reported_without_input_contents() {
        let error = read_document(&b"apiKey: secret-sentinel"[..], &CancellationToken::new())
            .await
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret-sentinel"));
        let missing = tempfile::tempdir().unwrap().path().join("missing.yaml");
        let error = document(&missing, YAML, &CancellationToken::new())
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.downcast_ref::<io::Error>().unwrap().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn output_goes_only_to_the_selected_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.yaml");
        std::fs::write(&path, b"old contents").unwrap();
        let mut stdout = Vec::new();
        write_output(Some(&path), YAML, &mut stdout).unwrap();
        assert!(stdout.is_empty());
        assert_eq!(std::fs::read(path).unwrap(), YAML);
        write_output(None, YAML, &mut stdout).unwrap();
        assert_eq!(stdout, YAML);
    }

    #[test]
    fn write_failure_is_propagated_and_failed_persist_removes_temporary_file() {
        assert_eq!(
            write_output(None, YAML, &mut [0u8; 0][..])
                .unwrap_err()
                .kind(),
            io::ErrorKind::WriteZero
        );
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("existing-directory");
        std::fs::create_dir(&target).unwrap();
        assert!(write_output(Some(&target), YAML, Vec::new()).is_err());
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn sync_failure_preserves_the_prior_complete_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.yaml");
        std::fs::write(&path, b"prior complete file").unwrap();
        let error = write_path(&path, YAML, |_| {
            Err(io::Error::other("injected sync failure"))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(std::fs::read(&path).unwrap(), b"prior complete file");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
