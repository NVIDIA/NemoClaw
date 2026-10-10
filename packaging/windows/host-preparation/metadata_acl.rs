// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The only admitted mutation is adding missing explicit, non-inheriting
//! metadata ACEs. All existing ACE bytes/order and owner/group remain fixed.

pub const METADATA_MASK: u32 = 0x0012_0088;
pub const MAX_DESCRIPTOR: usize = 256 * 1024;
const REQUIRED_SIDS: [[u8; 16]; 2] = [
    [1, 2, 0, 0, 0, 0, 0, 15, 2, 0, 0, 0, 1, 0, 0, 0],
    [1, 2, 0, 0, 0, 0, 0, 15, 2, 0, 0, 0, 2, 0, 0, 0],
];

#[derive(Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub bytes: Vec<u8>,
    pub control: u16,
    pub owner: Option<Vec<u8>>,
    pub group: Option<Vec<u8>>,
    pub acl: Vec<u8>,
    pub aces: Vec<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub acl: Vec<u8>,
    pub aces: Vec<Vec<u8>>,
    pub additions: usize,
}

fn word(bytes: &[u8], offset: usize) -> Result<u16, &'static str> {
    let value = bytes.get(offset..offset + 2).ok_or("descriptor-bound")?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn dword(bytes: &[u8], offset: usize) -> Result<u32, &'static str> {
    let value = bytes.get(offset..offset + 4).ok_or("descriptor-bound")?;
    Ok(u32::from_le_bytes(
        value.try_into().map_err(|_| "descriptor-bound")?,
    ))
}

fn sid(bytes: &[u8], offset: usize) -> Result<Vec<u8>, &'static str> {
    let header = bytes.get(offset..offset + 8).ok_or("sid-bound")?;
    if header[0] != 1 || header[1] > 15 {
        return Err("sid-format");
    }
    let size = 8 + usize::from(header[1]) * 4;
    Ok(bytes
        .get(offset..offset + size)
        .ok_or("sid-bound")?
        .to_vec())
}

fn descriptor_sid(bytes: &[u8], at: usize) -> Result<Option<Vec<u8>>, &'static str> {
    let offset = dword(bytes, at)? as usize;
    if offset == 0 {
        return Ok(None);
    }
    if offset < 20 || offset % 4 != 0 {
        return Err("descriptor-sid-offset");
    }
    Ok(Some(sid(bytes, offset)?))
}

impl Descriptor {
    pub fn parse(bytes: Vec<u8>) -> Result<Self, &'static str> {
        if bytes.len() < 20 || bytes.len() > MAX_DESCRIPTOR || bytes[0] != 1 {
            return Err("descriptor-format");
        }
        let control = word(&bytes, 2)?;
        if control & 0x8004 != 0x8004 {
            return Err("descriptor-dacl-required");
        }
        let owner = descriptor_sid(&bytes, 4)?;
        let group = descriptor_sid(&bytes, 8)?;
        let at = dword(&bytes, 16)? as usize;
        if at < 20 || at % 4 != 0 {
            return Err("descriptor-dacl-offset");
        }
        let size = usize::from(word(&bytes, at + 2)?);
        let acl = bytes.get(at..at + size).ok_or("acl-bound")?.to_vec();
        if acl.len() < 8 || !matches!(acl[0], 2 | 4) {
            return Err("acl-format");
        }
        let count = usize::from(word(&acl, 4)?);
        let mut aces = Vec::with_capacity(count);
        let mut offset = 8;
        for _ in 0..count {
            let size = usize::from(word(&acl, offset + 2)?);
            if size < 4 || size % 4 != 0 {
                return Err("ace-format");
            }
            aces.push(acl.get(offset..offset + size).ok_or("ace-bound")?.to_vec());
            offset += size;
        }
        Ok(Self {
            bytes,
            control,
            owner,
            group,
            acl,
            aces,
        })
    }

    pub fn plan(&self) -> Result<Plan, &'static str> {
        let mut found = [false; 2];
        for ace in &self.aces {
            if ace[1] & 0x10 != 0 {
                continue;
            }
            // An opaque explicit ACE cannot establish absence of a conflict.
            if !matches!(ace[0], 0..=3) {
                return Err("unsupported-explicit-ace");
            }
            let trustee = sid(ace, 8)?;
            if trustee.len() + 8 != ace.len() {
                return Err("unsupported-explicit-ace");
            }
            for (index, required) in REQUIRED_SIDS.iter().enumerate() {
                if trustee.as_slice() == required {
                    if ace[0] != 0 || ace[1] != 0 || dword(ace, 4)? != METADATA_MASK {
                        return Err("conflicting-metadata-ace");
                    }
                    found[index] = true;
                }
            }
        }
        let mut additions = Vec::new();
        for (index, required) in REQUIRED_SIDS.iter().enumerate() {
            if !found[index] {
                let mut ace = vec![0, 0, 24, 0];
                ace.extend_from_slice(&METADATA_MASK.to_le_bytes());
                ace.extend_from_slice(required);
                additions.push(ace);
            }
        }
        let count = additions.len();
        if count == 0 {
            return Ok(Plan {
                acl: self.acl.clone(),
                aces: self.aces.clone(),
                additions: 0,
            });
        }
        let index = self
            .aces
            .iter()
            .position(|ace| ace[1] & 0x10 != 0)
            .unwrap_or(self.aces.len());
        let mut aces = self.aces.clone();
        aces.splice(index..index, additions);
        let old_end = 8 + self.aces.iter().map(Vec::len).sum::<usize>();
        let mut acl = self.acl[..8].to_vec();
        for ace in &aces {
            acl.extend_from_slice(ace);
        }
        acl.extend_from_slice(&self.acl[old_end..]);
        let size = u16::try_from(acl.len()).map_err(|_| "acl-size")?;
        let ace_count = u16::try_from(aces.len()).map_err(|_| "acl-count")?;
        acl[2..4].copy_from_slice(&size.to_le_bytes());
        acl[4..6].copy_from_slice(&ace_count.to_le_bytes());
        Ok(Plan {
            acl,
            aces,
            additions: count,
        })
    }

    pub fn verify(&self, plan: &Plan, after: &Self) -> Result<(), &'static str> {
        let control_matches = after.control == self.control
            || (plan.additions != 0
                && self.control & 0x0400 == 0
                && after.control == (self.control | 0x0400));
        if self.owner != after.owner || self.group != after.group || !control_matches {
            return Err("descriptor-identity-changed");
        }
        if after.acl[0] != self.acl[0] || after.aces != plan.aces {
            return Err("existing-ace-sequence-changed");
        }
        if plan.additions == 0 && after.bytes != self.bytes {
            return Err("prepared-descriptor-changed");
        }
        Ok(())
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

#[cfg(test)]
#[path = "metadata_acl_tests.rs"]
mod tests;
