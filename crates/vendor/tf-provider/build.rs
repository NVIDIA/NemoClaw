fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .protoc_arg("--experimental_allow_proto3_optional")
        .message_attribute(".", "#[allow(dead_code)]")
        .build_client(false)
        .compile_protos(
            &["proto/plugin.proto", "proto/tfplugin6.5.proto"],
            &["proto"],
        )?;
    Ok(())
}
