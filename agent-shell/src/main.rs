// Cangkang jendela Live2D Agent — satu exe, dua mode.
//
//   live2d-shell.exe pet  <url>   → jendela pet: transparan, selalu di atas,
//                                   tanpa frame, tanpa taskbar, klik-tembus.
//   live2d-shell.exe main <url>   → jendela utama app: berdekorasi normal,
//                                   bisa diresize.
//   argv[1] langsung berupa http… → dianggap pet (kompatibel panggilan lama).
//
// URL diterima dari server Bun / start.bat supaya ikut PORT yang sebenarnya.
// Sebelum jendela dibuat, shell menunggu port server terbuka (maks 15 dtk):
// start.bat menyalakan shell dan server hampir bersamaan, dan WebView tidak
// punya retry — tanpa menunggu, jendela bisa menampilkan halaman error.
//
// Kenapa bukan Electron: WebView2 sudah menjadi bagian dari Windows 10/11,
// jadi binary-nya kecil (±3MB) dan RAM jendela ±40-90MB — tidak membawa
// Chromium sendiri seperti Electron.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const FALLBACK_PET_URL: &str = "http://127.0.0.1:8310/pet.html";
const FALLBACK_MAIN_URL: &str = "http://127.0.0.1:8310/";

enum Mode {
    Main,
    Pet,
}

struct Launch {
    mode: Mode,
    url: String,
}

fn parse_args() -> Launch {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("main") => Launch {
            mode: Mode::Main,
            url: args.next().unwrap_or_else(|| FALLBACK_MAIN_URL.into()),
        },
        Some("pet") => Launch {
            mode: Mode::Pet,
            url: args.next().unwrap_or_else(|| FALLBACK_PET_URL.into()),
        },
        // Kompatibel: panggilan lama langsung memberi URL pet tanpa kata "pet".
        Some(url) if url.starts_with("http") => Launch {
            mode: Mode::Pet,
            url: url.into(),
        },
        _ => Launch {
            mode: Mode::Main,
            url: FALLBACK_MAIN_URL.into(),
        },
    }
}

// Tunggu sampai server menerima koneksi TCP (maks 15 dtk) — start.bat
// menyalakan shell sebelum server selesai bind.
fn wait_for_server(url: &str) {
    let host_port = url
        .split("//")
        .nth(1)
        .and_then(|h| h.split('/').next())
        .unwrap_or("127.0.0.1:8310")
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if TcpStream::connect(&host_port).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    // Tidak apa-apa: WebView tetap membuka URL; kalau server memang mati,
    // halaman errornya jujur.
}

fn main() {
    let launch = parse_args();
    wait_for_server(&launch.url);
    let main_mode = matches!(launch.mode, Mode::Main);
    tauri::Builder::default()
        .setup(move |app| {
            let parsed = launch
                .url
                .parse()
                .unwrap_or_else(|e| panic!("URL tidak valid ({}): {e}", launch.url));
            let label = if main_mode { "main" } else { "pet" };
            let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
                .title(if main_mode { "Live2D Agent" } else { "Live2D Pet" });
            if main_mode {
                // Jendela utama: aplikasi biasa — berdekorasi, bisa diresize.
                builder
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(700.0, 520.0)
                    .center()
                    .build()?;
            } else {
                // Pet: overlay murni di atas desktop.
                builder
                    .inner_size(420.0, 640.0)
                    .position(40.0, 40.0)
                    .decorations(false) // tanpa frame — murni overlay
                    .transparent(true) // latar tembus pandang: karakter melayang
                    .always_on_top(true) // native, tanpa trik PowerShell SetWindowPos
                    .skip_taskbar(true) // pet bukan aplikasi biasa, jangan isi taskbar
                    .resizable(false)
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("gagal menjalankan shell");
}
