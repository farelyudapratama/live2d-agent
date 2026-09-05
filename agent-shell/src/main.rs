// Cangkang jendela Live2D Agent — satu exe, dua mode.
//
//   live2d-shell.exe main <url>   → jendela utama app: berdekorasi normal,
//                                   bisa diresize.
//   live2d-shell.exe pet  <url>   → jendela pet: transparan, selalu di atas,
//                                   tanpa frame, tanpa taskbar, klik-tembus.
//   argv[1] langsung berupa http… → dianggap pet (kompatibel panggilan lama).
//
// URL diterima dari server Bun / start.bat supaya ikut PORT yang sebenarnya.
// Sebelum jendela dibuat, shell menunggu port server terbuka (maks 15 dtk):
// start.bat menyalakan shell dan server hampir bersamaan, dan WebView tidak
// punya retry — tanpa menunggu, jendela bisa menampilkan halaman error.
// Kalau 15 dtk tidak cukup (mesin lambat / server gagal boot sesaat), jendela
// tetap dibuat dan thread pemulihan me-RELOAD begitu server terlihat — dulu
// halaman error WebView2 nyangkut permanen padahal server lalu naik sendiri.
//
// Kenapa bukan Electron: WebView2 sudah menjadi bagian dari Windows 10/11,
// jadi binary-nya kecil (±3MB) dan RAM jendela ±40-90MB — tidak membawa
// Chromium sendiri seperti Electron.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const FALLBACK_MAIN_URL: &str = "http://127.0.0.1:8310/";
const FALLBACK_PET_URL: &str = "http://127.0.0.1:8310/pet.html";
/** Batas pemulihan: kalau server belum juga naik dalam 2 menit, menyerah —
 *  user tinggal menutup jendela dan menjalankan start.bat lagi. */
const RECOVER_SECS: u64 = 120;

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

fn host_port_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|h| h.split('/').next())
        .unwrap_or("127.0.0.1:8310")
        .to_string()
}

fn can_connect(host_port: &str) -> bool {
    TcpStream::connect(host_port).is_ok()
}

fn main() {
    let launch = parse_args();
    let host_port = host_port_of(&launch.url);
    // Tunggu server bind (maks 15 dtk) SEBELUM jendela dibuat — kasus normal.
    let ready = {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if can_connect(&host_port) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    };
    let main_mode = matches!(launch.mode, Mode::Main);
    let label = if main_mode { "main" } else { "pet" };
    tauri::Builder::default()
        .setup(move |app| {
            let parsed = launch
                .url
                .parse()
                .unwrap_or_else(|e| panic!("URL tidak valid ({}): {e}", launch.url));
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
            if !ready {
                // Server belum ada saat jendela dibuat → WebView menampilkan
                // halaman error. Pantau port dan reload begitu server naik.
                let handle = app.handle().clone();
                let label = label.to_string();
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(RECOVER_SECS);
                    while Instant::now() < deadline {
                        if can_connect(&host_port) {
                            if let Some(w) = handle.get_webview_window(&label) {
                                let _ = w.eval("location.reload()");
                            }
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(1000));
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("gagal menjalankan shell");
}
