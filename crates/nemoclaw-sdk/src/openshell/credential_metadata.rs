// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::CREDENTIAL_SOURCE;
use crate::ObservationError;
use std::collections::HashMap;

// The pinned gateway permits 128 annotations, each with at most 8192 bytes.
// Keep structured references out of its short, selector-oriented label values.
const PART_BYTES: usize = 8192;
const MAX_PARTS: usize = 127;

pub(crate) fn pack(mut source: &str) -> Result<HashMap<String, String>, ObservationError> {
    let mut result = HashMap::new();
    if source.is_empty() {
        return Ok(result);
    }
    let mut count = 0;
    while !source.is_empty() {
        if count == MAX_PARTS {
            return Err(ObservationError::Incomplete);
        }
        let mut end = source.len().min(PART_BYTES);
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        result.insert(format!("{CREDENTIAL_SOURCE}-{count}"), source[..end].into());
        source = &source[end..];
        count += 1;
    }
    result.insert(CREDENTIAL_SOURCE.into(), count.to_string());
    Ok(result)
}

pub(crate) fn unpack(values: &HashMap<String, String>) -> Result<String, ObservationError> {
    let owned = values
        .keys()
        .filter(|key| key.starts_with(CREDENTIAL_SOURCE))
        .count();
    if owned == 0 {
        return Ok(String::new());
    }
    let count = values
        .get(CREDENTIAL_SOURCE)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| (1..=MAX_PARTS).contains(n) && owned == n + 1)
        .ok_or(ObservationError::Incomplete)?;
    let mut source = String::new();
    for index in 0..count {
        let part = values
            .get(&format!("{CREDENTIAL_SOURCE}-{index}"))
            .filter(|s| !s.is_empty() && s.len() <= PART_BYTES)
            .ok_or(ObservationError::Incomplete)?;
        source.push_str(part);
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_unicode_references_fit_native_annotations_and_incomplete_parts_fail() {
        let source = format!("{{\"value\":\"{}\"}}", "€".repeat(9000));
        let packed = pack(&source).unwrap();
        assert!(packed.len() <= 128);
        assert!(packed.values().all(|s| s.len() <= 8192));
        assert_eq!(unpack(&packed).unwrap(), source);
        for key in packed.keys() {
            let mut missing = packed.clone();
            missing.remove(key);
            assert!(unpack(&missing).is_err());
        }
        assert!(pack(&"a".repeat(128 * 8192)).is_err());
    }
}
