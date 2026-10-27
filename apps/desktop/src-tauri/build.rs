use std::path::Path;

fn main() {
    brand_tokens();
    // Declaring the app commands makes them ACL-checked: only windows/origins granted in
    // capabilities/ can call them (the local splash page, never the remote admin panel).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "splash_status",
        "splash_retry",
        "splash_open_logs",
    ])))
    .expect("failed to run tauri-build");
}

/// The splash takes its colors and font from the brand tokens (assets/brand/tokens.css, the
/// single source of truth); until that file exists, from a neutral stub with the same names.
/// Copied before the splash is embedded into the binary.
fn brand_tokens() {
    let brand = Path::new("../../../assets/brand/tokens.css");
    let stub = Path::new("../splash/tokens.stub.css");
    println!("cargo:rerun-if-changed={}", brand.display());
    println!("cargo:rerun-if-changed={}", stub.display());
    let source = if brand.exists() { brand } else { stub };
    let css = std::fs::read(source).unwrap_or_else(|e| panic!("cannot read {}: {e}", source.display()));
    let dest = Path::new("../splash/tokens.css");
    if std::fs::read(dest).ok().as_deref() != Some(css.as_slice()) {
        std::fs::write(dest, css).unwrap_or_else(|e| panic!("cannot write {}: {e}", dest.display()));
    }
}
