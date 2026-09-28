// Ohne dieses Attribut oeffnet Windows zusaetzlich ein Konsolenfenster.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    soloops_desktop::run()
}
