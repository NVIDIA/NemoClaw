// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Owner replicas the gateway reported for sandboxes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tonic::metadata::AsciiMetadataValue;

/// A stale owner is safe: a live non-owner replica relays the call.
const OWNER_TTL: Duration = Duration::from_secs(30);
const MAX_OWNERS: usize = 1024;

type Entries = HashMap<(String, String), (Instant, Option<AsciiMetadataValue>)>;

/// Owner the gateway last reported; `None` means it reported none.
pub struct Cached(pub Option<AsciiMetadataValue>);

/// Reported owners keyed by workspace and sandbox name.
#[derive(Clone, Default)]
pub struct OwnerCache(Arc<Mutex<Entries>>);

impl OwnerCache {
    pub fn get(&self, workspace: &str, name: &str) -> Option<Cached> {
        let entries = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let (stored, owner) = entries.get(&key(workspace, name))?;
        (stored.elapsed() < OWNER_TTL).then(|| Cached(owner.clone()))
    }

    pub fn insert(&self, workspace: &str, name: &str, owner: Option<AsciiMetadataValue>) {
        let mut entries = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if entries.len() >= MAX_OWNERS {
            entries.clear();
        }
        entries.insert(key(workspace, name), (Instant::now(), owner));
    }

    pub fn forget(&self, workspace: &str, name: &str) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key(workspace, name));
    }
}

fn key(workspace: &str, name: &str) -> (String, String) {
    (workspace.to_string(), name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_distinguishes_unknown_from_no_owner() {
        let cache = OwnerCache::default();
        assert!(cache.get("default", "box").is_none());
        cache.insert("default", "box", None);
        assert!(cache.get("default", "box").is_some_and(|c| c.0.is_none()));
        assert!(cache.get("team", "box").is_none());
        cache.forget("default", "box");
        assert!(cache.get("default", "box").is_none());
    }
}
