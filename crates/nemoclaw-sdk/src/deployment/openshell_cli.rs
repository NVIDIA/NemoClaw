// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[cfg(unix)]
use crate::kubernetes::receipt::private_directory;

impl Deployment {
    /// The bundled OpenShell CLI, set to run `args` against this deployment's
    /// gateway and workspace through OpenShell's documented selectors. Its
    /// configuration lives in the state directory, apart from the user's own.
    /// When the gateway sets `oidc` and OpenShell has not registered it, also
    /// returns the `openshell` arguments that register it and sign in.
    #[cfg(unix)]
    pub fn openshell(
        &self,
        args: &[std::ffi::OsString],
    ) -> Result<(std::process::Command, Option<String>), Error> {
        let (bundle, store) = self.open()?;
        if !bundle.manifest.files.contains_key("libexec/openshell") {
            return Err(Error::Bundle(
                "the bundle has no OpenShell CLI; OpenShell publishes none for this platform",
            ));
        }
        let document = store
            .load()?
            .ok_or(Error::State("no deployment; apply one first"))?
            .document;
        let gateway = &document.spec.gateway;
        let endpoint = gateway.endpoint().ok_or(Error::State(
            "the gateway has no endpoint for the OpenShell CLI to reach",
        ))?;
        let workspace = document.workspace();
        let configuration = std::path::absolute(self.state_directory.join("openshell"))
            .map_err(|_| Error::State("cannot resolve state directory"))?;
        let profile = configuration.join("openshell/gateways").join(&workspace);
        private_directory(&profile)?;
        if let Some(tls) = gateway.tls() {
            // Link the referenced files into OpenShell's mTLS layout.
            let mtls = profile.join("mtls");
            private_directory(&mtls)?;
            for (name, reference) in [
                ("ca.crt", Some(&tls.ca)),
                ("tls.crt", tls.certificate.as_ref()),
                ("tls.key", tls.key.as_ref()),
            ] {
                let link = mtls.join(name);
                let _ = fs::remove_file(&link);
                if let Some(reference) = reference {
                    let target = std::path::absolute(self.secrets.resolve(&reference.env)?)
                        .map_err(|_| Error::State("cannot resolve TLS file path"))?;
                    std::os::unix::fs::symlink(target, &link)
                        .map_err(|_| Error::State("cannot link TLS file for OpenShell"))?;
                }
            }
        }
        // OpenShell signs in to an OIDC gateway when it is registered; until
        // then, give the arguments that register this one.
        let mut sign_in = None;
        if let crate::config::Gateway::External(external) = gateway
            && let Some(oidc) = &external.oidc
            && !profile.join("metadata.json").exists()
            && args.first().is_none_or(|first| first != "gateway")
        {
            let mut add = format!(
                "gateway add {endpoint} --name {workspace} --oidc-issuer {} --oidc-client-id {}",
                oidc.issuer, oidc.client_id
            );
            if let Some(audience) = &oidc.audience {
                add += &format!(" --oidc-audience {audience}");
            }
            if let Some(scopes) = &oidc.scopes {
                add += &format!(" --oidc-scopes '{scopes}'");
            }
            sign_in = Some(add);
        }
        let mut command = std::process::Command::new(bundle.directory.join("libexec/openshell"));
        command
            .args(args)
            .env("XDG_CONFIG_HOME", &configuration)
            .env("OPENSHELL_SYSTEM_GATEWAY_DIR", configuration.join("system"))
            .env("OPENSHELL_GATEWAY", &workspace)
            .env("OPENSHELL_GATEWAY_ENDPOINT", &endpoint)
            .env("OPENSHELL_WORKSPACE", &workspace)
            .env_remove("OPENSHELL_GATEWAY_INSECURE");
        Ok((command, sign_in))
    }
}
