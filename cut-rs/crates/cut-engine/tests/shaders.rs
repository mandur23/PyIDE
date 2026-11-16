//! The WGSL copied from the JavaScript: still what the JavaScript has, and valid for wgpu.

use cut_engine::gpu::{Gpu, variants};

#[test]
fn copies_match_the_javascript() {
    let tool = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/engine-wgsl.mjs");
    let out = std::process::Command::new("node").arg(tool).arg("--check").output().expect("node runs");
    assert!(out.status.success(), "rerun node tools/engine-wgsl.mjs: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn every_shader_compiles_on_wgpu() {
    let (device, queue) = Gpu::headless().expect("a GPU");
    let mut gpu = Gpu::new(device.clone(), queue);
    let mut failed = Vec::new();
    for (name, format, blend) in variants() {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        gpu.pipeline(&name, format, blend);
        if let Some(e) = pollster::block_on(scope.pop()) {
            failed.push(format!("{name} {format:?} blend {blend}: {e}"));
        }
    }
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    gpu.compute_pipeline("scopes");
    if let Some(e) = pollster::block_on(scope.pop()) {
        failed.push(format!("scopes: {e}"));
    }
    assert!(failed.is_empty(), "{}", failed.join("\n\n"));
}
