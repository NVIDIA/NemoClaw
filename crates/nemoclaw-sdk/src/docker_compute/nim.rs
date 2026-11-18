// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Docker's bridge isolation keeps native NIM management ports behind nginx.
use super::*;

fn native(target: &Target) -> Result<Option<Spec>, Error> {
    if target.kind != "inference_service" {
        return Ok(None);
    }
    let spec = spec(target)?;
    Ok(matches!(
        nemoclaw_runtime::RuntimeSpec::decode(spec.runtime_configuration()?)?,
        nemoclaw_runtime::RuntimeSpec::Nim(_)
    )
    .then_some(spec))
}
pub(super) fn targets(raw: &[Target]) -> Result<Vec<Target>, Error> {
    let mut targets = Vec::new();
    for target in raw {
        let Some(spec) = native(target)? else {
            continue;
        };
        let network = format!("{}-backend", spec.name);
        targets.push(Target {
            kind: "docker_network".into(),
            address: format!("docker_network.network_{}", digest(spec.engine(), &network)),
            values: Row::from([
                ("engine".into(), spec.engine().into()),
                ("name".into(), network),
                (
                    "cidr".into(),
                    target
                        .values
                        .get("backend_network_cidr")
                        .ok_or(Error::State("missing NIM backend network"))?
                        .clone(),
                ),
                ("owner".into(), spec.owner.clone()),
                ("private_backend".into(), "true".into()),
            ]),
        });
        targets.push(Target {
            kind: "docker_container".into(),
            address: format!("{}_proxy", address(&target.address)),
            values: Row::from([
                ("name".into(), format!("{}-proxy", spec.name)),
                ("engine".into(), spec.engine().into()),
            ]),
        });
    }
    Ok(targets)
}
pub(super) fn configure(graph: &mut Value, raw: &[Target]) -> Result<(), Error> {
    for target in raw {
        let Some(spec) = native(target)? else {
            continue;
        };
        let process = spec
            .process
            .as_ref()
            .ok_or(Error::State("missing NIM process"))?;
        let physical = address(&target.address);
        let logical = physical
            .split_once('.')
            .ok_or(Error::State("invalid NIM address"))?
            .1;
        let private = format!("{}-backend", spec.name);
        let network = format!("docker_network.network_{}", digest(spec.engine(), &private));
        let attrs = &mut graph["resource"]["docker_container"][logical];
        attrs
            .as_object_mut()
            .ok_or(Error::State("missing NIM container"))?
            .remove("ports");
        attrs.as_object_mut().unwrap().remove("network_mode");
        attrs["networks_advanced"] = json!([{"name":private}]);
        let mut file = json!(
            target
                .values
                .get("ngc_credential_file")
                .ok_or(Error::State("missing NIM NGC file reference"))?
        );
        literal(&mut file);
        attrs["mounts"].as_array_mut().unwrap().push(json!({
            "type":"bind", "source":file,
            "target":"/run/nemoclaw/ngc-api-key", "read_only":true,
        }));
        add_dependencies(attrs, &[json!(network)]);
        let mut proxy = json!({
            "name":format!("{}-proxy", spec.name), "image":attrs["image"], "provider":attrs["provider"],
            "user":"1000:0", "entrypoint":["nginx"],
            "env":["NVIDIA_VISIBLE_DEVICES=void"],
            "command":["-e","/tmp/error.log","-c","/etc/nemoclaw/nim-proxy.conf","-g","daemon off;"],
            "networks_advanced":[{"name":private},{"name":spec.network()}],
            "ports":[{"internal":process.port,"external":process.port,"ip":process.bind_address,"protocol":"tcp"}],
            "capabilities":[{"drop":["ALL"]}], "security_opts":["no-new-privileges"],
            "sysctls":{"net.ipv4.ip_forward":"0","net.ipv6.conf.all.forwarding":"0"},
            "restart":"no", "memory":256,"memory_swap":256,
            "log_driver":"json-file","log_opts":{"max-size":"32m","max-file":"3"},
            "labels":[{"label":crate::managed::OWNER_LABEL,"value":spec.owner}],
            "must_run":true,"wait":false,"remove_volumes":false,"destroy_grace_seconds":15,
            "upload":[{"file":"/etc/nemoclaw/nim-proxy.conf","content":proxy_configuration(&spec.name, process.port),"permissions":"0444","owner":"0","group":"0"}],
            "depends_on":[physical], "lifecycle":{"replace_triggered_by":[physical]},
        });
        // Image/provider references already contain OpenTofu expressions.
        for field in ["name", "networks_advanced", "ports", "labels", "upload"] {
            literal(&mut proxy[field]);
        }
        graph["resource"]["docker_container"][format!("{logical}_proxy")] = proxy;
    }
    Ok(())
}

fn proxy_configuration(native: &str, port: u16) -> String {
    let mut locations = String::new();
    for (path, method) in [
        ("/v1/models", "GET"),
        ("/v1/chat/completions", "POST"),
        ("/v1/completions", "POST"),
    ] {
        locations.push_str(&format!("location = {path} {{ if ($request_method != {method}) {{ return 404; }} proxy_pass http://{native}:{port}; }}\n"));
    }
    format!(
        r#"pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {{ worker_connections 1024; }}
http {{
  access_log off;
  client_body_temp_path /tmp/client-body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  client_max_body_size 64m;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 600s;
  server {{ listen {port};
    {locations}
    location / {{ return 404; }}
  }}
}}
"#
    )
}
