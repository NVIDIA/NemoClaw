// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Compact complete-content manifest. The native caller must authenticate the
//! manifest SHA256 against the embedded MSI tuple before parsing these records.
use super::runtime_transaction::{Error, RuntimeIdentity};
use std::collections::BTreeMap;

pub const MAX_MANIFEST_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Directory,
    File { size: u64, sha256: String },
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

pub fn validate_relative(value: &str) -> Result<(), Error> {
    if value.is_empty() || value.len() > 8192 || value.contains('\\') {
        return Err(Error::Identity);
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with([' ', '.'])
            || part.chars().any(|v| v < ' ' || "<>:\"|?*".contains(v))
            || matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
            || ((stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(Error::Identity);
        }
    }
    if matches!(
        value.to_ascii_lowercase().as_str(),
        "runtime.manifest" | "runtime.ready" | "runtime.retired"
    ) {
        return Err(Error::Identity);
    }
    Ok(())
}

fn decode_path(value: &str) -> Result<String, Error> {
    if value.is_empty()
        || value.len() > 16384
        || value.len() % 2 != 0
        || !lower_hex(value, value.len())
    {
        return Err(Error::Identity);
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let digit = |v: u8| if v <= b'9' { v - b'0' } else { v - b'a' + 10 };
        bytes.push(digit(pair[0]) * 16 + digit(pair[1]));
    }
    let path = String::from_utf8(bytes).map_err(|_| Error::Identity)?;
    validate_relative(&path)?;
    Ok(path)
}

pub fn parse(bytes: &[u8], expected: &RuntimeIdentity) -> Result<BTreeMap<String, Entry>, Error> {
    expected.validate()?;
    if bytes.len() > MAX_MANIFEST_BYTES || !bytes.ends_with(b"\n") {
        return Err(Error::Identity);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Identity)?;
    let mut lines = text.split('\n');
    if lines.next() != Some("NEMOCLAW_RUNTIME_CONTENT_V1")
        || lines.next() != Some(expected.runtime_id.as_str())
        || lines.next() != Some(expected.source_revision.as_str())
        || lines.next() != Some(expected.node_sha256.as_str())
        || lines.next() != Some(expected.node_version.as_str())
    {
        return Err(Error::Identity);
    }
    let count_text = lines.next().ok_or(Error::Identity)?;
    let count = count_text.parse::<usize>().map_err(|_| Error::Identity)?;
    if count == 0 || count > MAX_ENTRIES || count.to_string() != count_text {
        return Err(Error::Identity);
    }
    let mut entries = BTreeMap::new();
    let mut previous = String::new();
    let mut file_count = 0;
    for _ in 0..count {
        let line = lines.next().ok_or(Error::Identity)?;
        if line.len() > 16500 {
            return Err(Error::Identity);
        }
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(Error::Identity);
        }
        let path = decode_path(fields[3])?;
        if path <= previous {
            return Err(Error::Identity);
        }
        let entry = match (fields[0], fields[1], fields[2]) {
            ("D", "-", "0") => Entry::Directory,
            ("F", digest, size) if lower_hex(digest, 64) => {
                let value = size.parse::<u64>().map_err(|_| Error::Identity)?;
                if value.to_string() != size {
                    return Err(Error::Identity);
                }
                file_count += 1;
                Entry::File {
                    size: value,
                    sha256: digest.into(),
                }
            }
            _ => return Err(Error::Identity),
        };
        previous = path.clone();
        entries.insert(path, entry);
    }
    if file_count == 0 || lines.next() != Some("") || lines.next().is_some() {
        return Err(Error::Identity);
    }
    // Every non-root parent is recorded; a path cannot be both file and parent.
    for name in entries.keys() {
        let mut current = name.as_str();
        while let Some((parent, _)) = current.rsplit_once('/') {
            if entries.get(parent) != Some(&Entry::Directory) {
                return Err(Error::Identity);
            }
            current = parent;
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> RuntimeIdentity {
        RuntimeIdentity {
            runtime_id: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            source_revision: "c".repeat(40),
            node_sha256: "d".repeat(64),
            node_version: "22.23.2".into(),
        }
    }
    fn encoded(records: &[&str]) -> Vec<u8> {
        format!(
            "NEMOCLAW_RUNTIME_CONTENT_V1\n{}\n{}\n{}\n22.23.2\n{}\n{}\n",
            "a".repeat(64),
            "c".repeat(40),
            "d".repeat(64),
            records.len(),
            records.join("\n")
        )
        .into_bytes()
    }
    #[test]
    fn complete_file_and_empty_directory_inventory_parses() {
        let file = format!("F\t{}\t3\t646174612e747874", "e".repeat(64));
        let records = parse(&encoded(&[&file, "D\t-\t0\t656d707479"]), &target()).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records.get("empty"), Some(&Entry::Directory));
    }
    #[test]
    fn missing_parent_and_extra_records_are_rejected() {
        let file = format!("F\t{}\t3\t6469722f646174612e747874", "e".repeat(64));
        assert_eq!(parse(&encoded(&[&file]), &target()), Err(Error::Identity));
        let good = format!("F\t{}\t3\t646174612e747874", "e".repeat(64));
        let mut bytes = encoded(&[&good]);
        bytes.extend_from_slice(b"extra\n");
        assert_eq!(parse(&bytes, &target()), Err(Error::Identity));
    }
    #[test]
    fn shared_node_and_source_tuple_mismatch_are_rejected() {
        let file = format!("F\t{}\t3\t646174612e747874", "e".repeat(64));
        let mut wrong = target();
        wrong.node_sha256 = "f".repeat(64);
        assert_eq!(parse(&encoded(&[&file]), &wrong), Err(Error::Identity));
    }
    #[test]
    fn traversal_drive_names_and_reserved_control_files_are_rejected() {
        for name in [
            "../other",
            "C:/other",
            "dir/../other",
            "runtime.ready",
            "COM1.txt",
            "dir/trailing.",
        ] {
            assert_eq!(validate_relative(name), Err(Error::Identity));
        }
    }
}
