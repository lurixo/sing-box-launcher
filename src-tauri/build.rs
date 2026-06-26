fn main() {
    if let Ok(protoc) = protoc_bin_vendored::protoc_bin_path() {
        unsafe {
            std::env::set_var("PROTOC", protoc);
        }
    }
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(&["proto/started_service.proto"], &["proto"])
        .expect("failed to compile protos");
    tauri_build::build();
}
