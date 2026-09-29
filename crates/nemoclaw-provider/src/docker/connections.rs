// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Engine;
use crate::Error;
use std::{collections::BTreeMap, sync::Arc};

/// Connection selection at the control-plane boundary. A fixed set is strict:
/// missing entries never fall back to environment defaults or a local daemon.
/// Resource bindings, rather than these transport keys, retain daemon identity.
#[derive(Clone, Default)]
pub struct Connections {
    fixed: Option<Arc<BTreeMap<String, Engine>>>,
}
impl Connections {
    pub fn fixed(engines: impl IntoIterator<Item = Engine>) -> Result<Self, Error> {
        let mut fixed = BTreeMap::new();
        for engine in engines {
            if fixed.insert(engine.endpoint().to_owned(), engine).is_some() {
                return Err(Error::Conflict("duplicate engine connection"));
            }
        }
        Ok(Self {
            fixed: Some(Arc::new(fixed)),
        })
    }
    pub fn resolve(&self, endpoint: &str) -> Result<Engine, Error> {
        match &self.fixed {
            Some(fixed) => fixed
                .get(endpoint)
                .cloned()
                .ok_or(Error::Conflict("engine connection was not supplied")),
            None => Engine::connect(endpoint),
        }
    }
}
