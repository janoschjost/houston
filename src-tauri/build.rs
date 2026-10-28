fn main() {
    // tauri_build only watches tauri.conf.json and capabilities; the app icon is embedded at compile time too.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
