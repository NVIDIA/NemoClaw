// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::runtime_transaction::Error;

// Called only after attachment succeeds. A verified mount stays attached for
// the transaction; every failed verification must attempt owner cleanup.
pub(super) fn finish_attachment(
    verify: impl FnOnce() -> Result<(), Error>,
    detach: impl FnOnce() -> Result<(), Error>,
) -> Result<(), Error> {
    match verify() {
        Ok(()) => Ok(()),
        Err(primary) => {
            detach().map_err(|_| Error::Native("runtime-image-mount-cleanup"))?;
            Err(primary)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn verified_mount_remains_attached() {
        assert_eq!(
            finish_attachment(|| Ok(()), || panic!("unexpected detach")),
            Ok(())
        );
    }

    #[test]
    fn missing_manifest_detaches_before_a_later_repair() {
        let attached = Cell::new(true);
        assert_eq!(
            finish_attachment(
                || Err(Error::Native("runtime-image-mount")),
                || {
                    assert!(attached.replace(false));
                    Ok(())
                },
            ),
            Err(Error::Native("runtime-image-mount")),
        );
        assert!(!attached.get());
        attached.set(true);
        assert_eq!(
            finish_attachment(|| Ok(()), || panic!("unexpected detach")),
            Ok(())
        );
        assert!(attached.get());
    }

    #[test]
    fn mount_setup_failures_keep_their_primary_error_after_cleanup() {
        for (primary, expected) in [
            (Error::Identity, Error::Identity),
            (
                Error::Native("runtime-image-diskpart"),
                Error::Native("runtime-image-diskpart"),
            ),
            (
                Error::Native("runtime-image-acl"),
                Error::Native("runtime-image-acl"),
            ),
        ] {
            let detached = Cell::new(false);
            let result = finish_attachment(
                || Err(primary),
                || {
                    detached.set(true);
                    Ok(())
                },
            );
            assert_eq!(result, Err(expected));
            assert!(detached.get());
        }
    }

    #[test]
    fn failed_detach_reports_retained_mount() {
        assert_eq!(
            finish_attachment(
                || Err(Error::Native("runtime-image-mount")),
                || Err(Error::Native("runtime-image-detach")),
            ),
            Err(Error::Native("runtime-image-mount-cleanup")),
        );
    }
}
