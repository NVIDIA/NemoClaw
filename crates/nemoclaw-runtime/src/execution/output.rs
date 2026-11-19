// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
pub(crate) const OUTPUT_LIMIT: usize = crate::EXITED_OUTPUT_LIMIT;
/// A backend's standard output and error, forwarded unchanged to the runtime's
/// standard error for the container log. The end is kept for the error that
/// reports the backend's exit, because backends log and raise their startup
/// errors there.
pub(crate) struct Output {
    kept: Arc<Mutex<Kept>>,
    closed: tokio::sync::oneshot::Receiver<()>,
    credential: Option<String>,
}
#[derive(Default)]
struct Kept {
    bytes: VecDeque<u8>,
    truncated: bool,
}
impl Kept {
    fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes);
        if self.bytes.len() > OUTPUT_LIMIT {
            self.bytes.drain(..self.bytes.len() - OUTPUT_LIMIT);
            self.truncated = true;
        }
    }
}
impl Output {
    pub(crate) fn start(reader: std::io::PipeReader, credential: Option<String>) -> Self {
        let kept = Arc::new(Mutex::new(Kept::default()));
        let (closed_tx, closed) = tokio::sync::oneshot::channel();
        let shared = kept.clone();
        // A thread, not a runtime task: a process outside the backend's group
        // may hold the pipe open, and the runtime must still be able to exit.
        std::thread::spawn(move || {
            use std::io::{ErrorKind, Read, Write};
            let mut reader = reader;
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let _ = std::io::stderr().write_all(&buffer[..read]);
                        shared
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push(&buffer[..read]);
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = closed_tx.send(());
        });
        Self {
            kept,
            closed,
            credential,
        }
    }
    /// Add the end of the backend's output to the error for its exit. Call it
    /// after supervision stopped the backend's process group, whose workers
    /// hold the pipe open until then.
    pub(crate) async fn explain(self, result: Result<(), Error>) -> Result<(), Error> {
        let Err(Error::Exited(None)) = result else {
            return result;
        };
        // A process that left the group can hold the pipe open; report what arrived.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.closed).await;
        let mut kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        let truncated = kept.truncated;
        let bytes = kept.bytes.make_contiguous();
        // Cutting the output can split a line, a character, or the key, so a
        // cut output starts after its first line break.
        let start = if truncated {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |end| end + 1)
        } else {
            0
        };
        let mut text = String::from_utf8_lossy(&bytes[start..])
            .trim_end()
            .to_owned();
        // The backend receives the key in its environment; keep it out of errors.
        if let Some(key) = &self.credential {
            text = text.replace(key.as_str(), "[redacted]");
        }
        Err(Error::Exited((!text.is_empty()).then_some(text)))
    }
}
