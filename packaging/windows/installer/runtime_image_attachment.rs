// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::runtime_transaction::{Error, RuntimeIdentity};

// READ_ONLY | NO_DRIVE_LETTER | PERMANENT_LIFETIME. Windows rejects AT_BOOT
// with these read-only handles; the MSI-owned service restores the image at boot.
pub(super) const INSTALLED_IMAGE_ATTACH_FLAGS: u32 = 0x1 | 0x2 | 0x4;

#[repr(C)]
#[derive(Default)]
pub(super) struct StorageDeviceNumber {
    pub device_type: u32,
    pub device_number: u32,
    pub partition_number: u32,
}

impl StorageDeviceNumber {
    pub fn is_runtime_partition(&self, disk: &Self) -> bool {
        self.device_type == 7
            && disk.device_type == 7
            && self.device_number == disk.device_number
            && self.partition_number == 1
    }
}

pub(super) fn select_runtime_volume(
    disk: &StorageDeviceNumber,
    mut next: impl FnMut() -> Result<Option<(Vec<u16>, Option<StorageDeviceNumber>)>, u32>,
) -> Result<Vec<u16>, u32> {
    if disk.device_type != 7 {
        return Err(13);
    }
    let mut selected = None;
    for _ in 0..4096 {
        let Some((volume, number)) = next()? else {
            return selected.ok_or(1168);
        };
        if number.is_some_and(|number| number.is_runtime_partition(disk)) {
            if selected.is_some() {
                return Err(13);
            }
            selected = Some(volume);
        }
    }
    Err(122)
}

// NTFS creates this volume-root directory independently of the package payload.
// Never exempt a loose-runtime entry, nested name, file, or reparse point.
pub(super) fn is_volume_metadata(read_only_image_root: bool, relative: &str, attributes: u32) -> bool {
    read_only_image_root && relative == "System Volume Information" && attributes == 0x16
}

pub(super) fn validate_boot_restore(
    expected: &RuntimeIdentity,
    selected: &RuntimeIdentity,
    embedded_id: Option<&str>,
    embedded_digest: Option<&str>,
    maintenance_active: bool,
) -> Result<(), Error> {
    expected.validate()?;
    let valid_digest = embedded_digest.is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if embedded_id != Some(expected.runtime_id.as_str()) || !valid_digest || selected != expected {
        return Err(Error::Identity);
    }
    if maintenance_active {
        return Err(Error::Busy);
    }
    Ok(())
}

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
    fn runtime_mount_requires_partition_one_on_the_exact_physical_disk() {
        assert_eq!(std::mem::size_of::<StorageDeviceNumber>(), 12);
        let disk = StorageDeviceNumber {
            device_type: 7,
            device_number: 4,
            partition_number: u32::MAX,
        };
        for (device_type, device_number, partition_number, accepted) in [
            (7, 4, 1, true),
            (7, 0, 1, false),
            (7, 5, 1, false),
            (7, 4, 0, false),
            (7, 4, 2, false),
            (7, 4, u32::MAX, false),
            (2, 4, 1, false),
            (0, 4, 1, false),
        ] {
            let volume = StorageDeviceNumber {
                device_type,
                device_number,
                partition_number,
            };
            assert_eq!(volume.is_runtime_partition(&disk), accepted);
            assert!(!volume.is_runtime_partition(&StorageDeviceNumber {
                device_type: 2,
                device_number: 4,
                partition_number: 0,
            }));
        }
    }

    #[test]
    fn runtime_volume_selection_rejects_missing_ambiguous_and_incomplete_inventory() {
        let disk = StorageDeviceNumber {
            device_type: 7,
            device_number: 4,
            partition_number: u32::MAX,
        };
        let matching = || StorageDeviceNumber {
            device_type: 7,
            device_number: 4,
            partition_number: 1,
        };
        let volume = vec![65, 0];
        let mut inventory = vec![
            Ok(Some((vec![66, 0], None))),
            Ok(Some((volume.clone(), Some(matching())))),
            Ok(None),
        ]
        .into_iter();
        assert_eq!(
            select_runtime_volume(&disk, || inventory.next().unwrap()),
            Ok(volume.clone())
        );
        assert_eq!(select_runtime_volume(&disk, || Ok(None)), Err(1168));
        assert_eq!(
            select_runtime_volume(&disk, || Ok(Some((volume.clone(), Some(matching()))))),
            Err(13)
        );
        let mut inventory = vec![Ok(Some((volume.clone(), Some(matching())))), Err(5)].into_iter();
        assert_eq!(
            select_runtime_volume(&disk, || inventory.next().unwrap()),
            Err(5)
        );
        let calls = Cell::new(0);
        assert_eq!(
            select_runtime_volume(&disk, || {
                calls.set(calls.get() + 1);
                Ok(Some((volume.clone(), None)))
            }),
            Err(122)
        );
        assert_eq!(calls.get(), 4096);
        assert_eq!(
            select_runtime_volume(&StorageDeviceNumber::default(), || panic!(
                "invalid disk must not enumerate"
            )),
            Err(13)
        );
    }

    #[test]
    fn volume_metadata_is_not_a_package_inventory_exemption() {
        assert!(is_volume_metadata(true, "System Volume Information", 0x16));
        for (image, name, attributes) in [
            (false, "System Volume Information", 0x16),
            (true, "hermes/System Volume Information", 0x16),
            (true, "system volume information", 0x16),
            (true, "extra.exe", 0x16),
            (true, "System Volume Information", 0x06),
            (true, "System Volume Information", 0x10),
            (true, "System Volume Information", 0x416),
        ] {
            assert!(!is_volume_metadata(image, name, attributes));
        }
    }

    fn identity() -> RuntimeIdentity {
        RuntimeIdentity {
            runtime_id: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            source_revision: "c".repeat(40),
            node_sha256: "d".repeat(64),
            node_version: "22.23.2".into(),
        }
    }

    #[test]
    fn startup_requires_exact_selected_image_and_no_maintenance() {
        let expected = identity();
        let digest = "e".repeat(64);
        assert_eq!(
            validate_boot_restore(
                &expected,
                &expected,
                Some(&expected.runtime_id),
                Some(&digest),
                false
            ),
            Ok(())
        );
        assert_eq!(
            validate_boot_restore(
                &expected,
                &expected,
                Some(&expected.runtime_id),
                Some(&digest),
                true
            ),
            Err(Error::Busy)
        );
        for field in 0..5 {
            let mut selected = expected.clone();
            match field {
                0 => selected.runtime_id = "f".repeat(64),
                1 => selected.manifest_sha256 = "f".repeat(64),
                2 => selected.source_revision = "f".repeat(40),
                3 => selected.node_sha256 = "f".repeat(64),
                _ => selected.node_version = "22.23.3".into(),
            }
            assert_eq!(
                validate_boot_restore(
                    &expected,
                    &selected,
                    Some(&expected.runtime_id),
                    Some(&digest),
                    false
                ),
                Err(Error::Identity)
            );
        }
    }

    #[test]
    fn startup_cannot_use_a_generic_or_malformed_image_helper() {
        let expected = identity();
        let digest = "e".repeat(64);
        let foreign = "f".repeat(64);
        for (id, hash) in [
            (None, None),
            (Some(expected.runtime_id.as_str()), None),
            (None, Some(digest.as_str())),
            (Some(foreign.as_str()), Some(digest.as_str())),
            (Some(expected.runtime_id.as_str()), Some("invalid")),
        ] {
            assert_eq!(
                validate_boot_restore(&expected, &expected, id, hash, false),
                Err(Error::Identity)
            );
        }
        let mut invalid = expected.clone();
        invalid.node_version = "latest".into();
        assert_eq!(
            validate_boot_restore(
                &invalid,
                &invalid,
                Some(&invalid.runtime_id),
                Some(&digest),
                false
            ),
            Err(Error::Identity)
        );
    }

    #[test]
    fn verified_mount_remains_attached() {
        assert_eq!(INSTALLED_IMAGE_ATTACH_FLAGS, 0x7);
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
