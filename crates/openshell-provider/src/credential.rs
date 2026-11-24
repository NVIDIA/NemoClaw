// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The digest NemoClaw records of the credential value it registers, so a
//! plan can tell when the variable a registration names holds another value.
//! OpenShell never reports a registered value, so the digest is NemoClaw's
//! only record of it: an Argon2id PHC string with a random salt, which checks
//! a candidate value without revealing the registered one.
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use nemoclaw_backend::ObservationError;
use tf_provider::value::Value;

/// The state attribute holding the digest. Empty when the registration takes
/// no credential from a variable, or none was recorded yet.
pub(crate) const CREDENTIAL_DIGEST: &str = "credential_digest";
/// A registration row field that registers the credential value again, even
/// when the registration already names the same variable. It is an
/// instruction to the mutation, not a field OpenShell reports.
pub(crate) const REGISTER: &str = "register_credential";

/// Argon2id with OWASP's minimum parameters: 19 MiB of memory, two passes,
/// and one lane.
fn argon2() -> Argon2<'static> {
    let params = Params::new(19_456, 2, 1, None).expect("OWASP's Argon2id parameters are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// The Argon2id digest of `value`, with a new random salt.
pub(crate) fn digest(value: &str) -> Result<String, ObservationError> {
    let mut salt = [0; 16];
    getrandom::fill(&mut salt)
        .map_err(|_| ObservationError::Backend("cannot generate a credential digest salt"))?;
    let salt = SaltString::encode_b64(&salt)
        .map_err(|_| ObservationError::Backend("cannot encode a credential digest salt"))?;
    argon2()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ObservationError::Backend("cannot digest a credential"))
}

/// Whether `digest` was made from `value`. Verification uses the parameters
/// the digest records.
pub(crate) fn verifies(digest: &str, value: &str) -> bool {
    PasswordHash::new(digest)
        .is_ok_and(|hash| argon2().verify_password(value.as_bytes(), &hash).is_ok())
}

/// The value of the variable `name`, as the provider resolves a registration's
/// credential: from its own environment, and only when set and not empty.
pub(crate) fn current(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Whether a registration takes its credential from the variable it names,
/// rather than from a credential source or not at all.
pub(crate) fn from_variable(row: &nemoclaw_backend::Row) -> bool {
    let text = |field: &str| row.get(field).map(String::as_str).unwrap_or_default();
    !text("credential_env").is_empty() && text("credential_source").is_empty()
}

/// The planning rule for [`CREDENTIAL_DIGEST`], with the provider's
/// environment.
pub(crate) fn plan(name: &str, prior: &nemoclaw_tofu::State) -> Option<Value<String>> {
    planned(name, prior, current)
}

/// Plan the digest from the value `read` finds in the variable the prior
/// registration names: unknown, which updates the registration with the
/// value, when the value doesn't verify against the recorded digest; the
/// recorded digest otherwise, including when the value can't be read.
pub(crate) fn planned(
    name: &str,
    prior: &nemoclaw_tofu::State,
    read: impl Fn(&str) -> Option<String>,
) -> Option<Value<String>> {
    let text = |field: &str| match prior.get(field) {
        Some(Value::Value(text)) => text.as_str(),
        _ => "",
    };
    let (recorded, variable) = (text(CREDENTIAL_DIGEST), text("credential_env"));
    if !recorded.is_empty()
        && !variable.is_empty()
        && text("credential_source").is_empty()
        && read(variable).is_some_and(|value| !verifies(recorded, &value))
    {
        return Some(Value::Unknown);
    }
    nemoclaw_tofu::carry_prior(name, prior)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALUE: &str = "nvapi-fixture-credential-value";

    fn prior(digest: &str, source: &str) -> nemoclaw_tofu::State {
        [
            ("credential_env", "NVIDIA_API_KEY"),
            ("credential_source", source),
            (CREDENTIAL_DIGEST, digest),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), Value::Value(value.into())))
        .collect()
    }

    fn holding(value: Option<&str>) -> impl Fn(&str) -> Option<String> {
        move |variable| {
            assert_eq!(variable, "NVIDIA_API_KEY");
            value.map(str::to_owned)
        }
    }

    #[test]
    fn a_digest_hides_its_value_and_verifies_only_that_value() {
        let first = digest(VALUE).unwrap();
        assert!(
            first.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
            "{first}"
        );
        assert!(!first.contains(VALUE));
        assert!(verifies(&first, VALUE));
        assert!(!verifies(&first, "nvapi-fixture-credential-valuf"));
        assert!(!verifies(&first, ""));
        assert!(!verifies("", VALUE));
        assert!(!verifies(VALUE, VALUE));
        // Each digest takes its own salt.
        let second = digest(VALUE).unwrap();
        assert_ne!(first, second);
        assert!(verifies(&second, VALUE));
    }

    #[test]
    fn a_changed_value_plans_the_digest_unknown() {
        let recorded = digest(VALUE).unwrap();
        assert_eq!(
            planned(
                CREDENTIAL_DIGEST,
                &prior(&recorded, ""),
                holding(Some("nvapi-new"))
            ),
            Some(Value::Unknown)
        );
    }

    #[test]
    fn the_same_or_an_unreadable_value_keeps_the_recorded_digest() {
        let recorded = digest(VALUE).unwrap();
        for value in [Some(VALUE), None] {
            assert_eq!(
                planned(CREDENTIAL_DIGEST, &prior(&recorded, ""), holding(value)),
                Some(Value::Value(recorded.clone())),
                "{value:?}"
            );
        }
    }

    #[test]
    fn without_a_recorded_digest_or_with_a_credential_source_nothing_changes() {
        assert_eq!(
            planned(CREDENTIAL_DIGEST, &prior("", ""), holding(Some(VALUE))),
            Some(Value::Value(String::new()))
        );
        // A Docker credential source supplies the value; the variable doesn't.
        let source = "docker:registry.example.com";
        assert_eq!(
            planned(
                CREDENTIAL_DIGEST,
                &prior("", source),
                |_: &str| -> Option<String> {
                    panic!("a credential source's registration read a variable")
                }
            ),
            Some(Value::Value(String::new()))
        );
    }
}
