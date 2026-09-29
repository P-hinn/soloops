// Without this attribute Windows opens an extra console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    soloops_desktop::run()
}
