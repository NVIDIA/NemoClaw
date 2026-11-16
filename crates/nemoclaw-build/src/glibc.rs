// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The oldest glibc that Linux bundles must run on.
//!
//! A dynamically linked executable records the glibc symbol versions it uses,
//! and the loader refuses to start it where one is missing, unless the
//! reference is weak. Building on an older glibc keeps the requirement low;
//! this check catches an executable that needs more than the supported
//! minimum.

use std::path::Path;

use object::read::elf::{FileHeader, SectionTable};

/// A glibc version, as (major, minor).
pub type Version = (u32, u32);

/// Parse a minimum such as `2.35`.
pub fn parse_minimum(text: &str) -> Result<Version, String> {
    parse(text).ok_or_else(|| format!("a glibc version is MAJOR.MINOR, such as 2.35, not {text:?}"))
}

fn parse(text: &str) -> Option<Version> {
    let (major, minor) = text.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// The newest glibc version among the needed symbol versions, each given by
/// name and whether its reference is weak. Weak references and other
/// libraries' versions do not count.
pub fn newest_required<'a>(needs: impl IntoIterator<Item = (&'a str, bool)>) -> Option<Version> {
    needs
        .into_iter()
        .filter(|(_, weak)| !weak)
        .filter_map(|(name, _)| parse(name.strip_prefix("GLIBC_")?))
        .max()
}

/// The newest glibc version that the ELF file at `path` requires, or `None`
/// when it is not a 64-bit ELF file or needs no versioned glibc symbol, as a
/// script, data, or a statically linked executable does.
pub fn required(path: &Path) -> Result<Option<Version>, String> {
    let data = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !data.starts_with(b"\x7fELF") {
        return Ok(None);
    }
    needed_versions(&data).map_err(|error| format!("{}: {error}", path.display()))
}

fn needed_versions(data: &[u8]) -> object::read::Result<Option<Version>> {
    let Ok(header) = object::elf::FileHeader64::<object::Endianness>::parse(data) else {
        return Ok(None);
    };
    let endian = header.endian()?;
    let sections: SectionTable<'_, object::elf::FileHeader64<object::Endianness>> =
        header.sections(endian, data)?;
    let Some((mut needs, link)) = sections.gnu_verneed(endian, data)? else {
        return Ok(None);
    };
    let strings = sections.strings(endian, data, link)?;
    let mut names = Vec::new();
    while let Some((_, mut auxiliaries)) = needs.next()? {
        while let Some(auxiliary) = auxiliaries.next()? {
            let name = String::from_utf8_lossy(auxiliary.name(endian, strings)?).into_owned();
            let weak = auxiliary.vna_flags.get(endian).0 & object::elf::VER_FLG_WEAK.0 != 0;
            names.push((name, weak));
        }
    }
    Ok(newest_required(
        names.iter().map(|(name, weak)| (name.as_str(), *weak)),
    ))
}

/// Check every file under `directory`, naming each executable that needs a
/// newer glibc than `minimum`.
pub fn check(directory: &Path, minimum: Version) -> Result<(), String> {
    let mut problems = Vec::new();
    let mut pending = vec![directory.to_path_buf()];
    while let Some(path) = pending.pop() {
        let entries =
            std::fs::read_dir(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("{}: {error}", path.display()))?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && let Some(needed) = required(&path)?
                && needed > minimum
            {
                problems.push(format!(
                    "{} needs glibc {}.{}, newer than the minimum {}.{}",
                    path.display(),
                    needed.0,
                    needed.1,
                    minimum.0,
                    minimum.1
                ));
            }
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    problems.sort();
    Err(format!(
        "{}\nBuild Linux executables on a host whose glibc is no newer than {}.{}.",
        problems.join("\n"),
        minimum.0,
        minimum.1
    ))
}
