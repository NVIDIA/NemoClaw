// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Test executables that a concurrently spawned child cannot keep busy.
//!
//! The kernel refuses to execute a file that any process holds open for
//! writing. A child that another test thread forks while this one writes a
//! file inherits the writable descriptor until it executes, so a script this
//! process writes can fail to start with `ExecutableFileBusy`. Here a separate
//! process writes the file; this process never opens it, so no fork can
//! inherit a writable descriptor.

use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

/// Create `path` with `contents` and mode 0700.
pub fn write_executable(path: &Path, contents: impl AsRef<[u8]>) {
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "umask 077 && cat > \"$1\" && chmod 700 \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("cannot start /bin/sh to write a test executable");
    writer
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(contents.as_ref())
        .expect("cannot send a test executable to /bin/sh");
    let status = writer.wait().expect("cannot wait for /bin/sh");
    assert!(
        status.success(),
        "cannot write {}: {status}",
        path.display()
    );
}
