// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::ConfigError;

/// The authored choice only; each consumer owns name lookup and declaration scope.
pub(super) enum DefinitionSource<'a, T> {
    Inline(&'a T),
    Reference(&'a str),
}

impl<'a, T> DefinitionSource<'a, T> {
    pub fn from_parts(
        inline: Option<&'a T>,
        reference: Option<&'a str>,
        message: &'static str,
    ) -> Result<Self, ConfigError> {
        match (inline, reference) {
            (Some(value), None) => Ok(Self::Inline(value)),
            (None, Some(name)) => Ok(Self::Reference(name)),
            _ => Err(ConfigError::new(message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DefinitionSource;

    #[test]
    fn selection_requires_exactly_one_authored_form() {
        let inline = 42;
        assert!(matches!(
            DefinitionSource::from_parts(Some(&inline), None, "choice"),
            Ok(DefinitionSource::Inline(&42))
        ));
        assert!(matches!(
            DefinitionSource::<u32>::from_parts(None, Some("shared"), "choice"),
            Ok(DefinitionSource::Reference("shared"))
        ));
        for (value, name) in [(None, None), (Some(&inline), Some("private-name"))] {
            let Err(error) = DefinitionSource::from_parts(value, name, "choice") else {
                panic!("ambiguous or absent selection accepted");
            };
            assert_eq!(error.to_string(), "choice");
        }
    }
}
