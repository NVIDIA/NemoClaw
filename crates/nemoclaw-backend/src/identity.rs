// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Generated identity for resources whose author omits it.

use crate::Error;

/// A random version 4 UUID for an omitted owner.
pub fn generate_owner() -> Result<String, Error> {
    let mut bytes = random()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// 32 random lowercase hexadecimal characters for an omitted generation.
pub fn generate_generation() -> Result<String, Error> {
    Ok(hex(&random()?))
}

fn random() -> Result<[u8; 16], Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::State("cannot generate resource identity"))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
