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
//
// Mode portable (release): bila exe server (live2d-agent.exe) ada di samping
// shell dan port masih kosong, shell menyalakannya sendiri (sidecar) dan
// mematikannya saat aplikasi ditutup — user cukup dobel-klik satu exe.
//
// Port (peluncuran TANPA argumen URL — dobel-klik shortcut installer): port
// dasar 8310 dipakai bila kosong ATAU sudah dipakai server milik kita sendiri
// (probe /api/mode — dobel-klik kedua menempel ke instance pertama). Bila
// port diduduki aplikasi ASING, shell bergeser ke 8311..8319. URL argumen
// eksplisit (start.bat / peluncuran dari server) selalu dihormati apa adanya.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
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
    /// true bila URL datang dari argumen user (dihormati apa adanya);
    /// false bila jatuh ke fallback — shell boleh memilih port sendiri.
    explicit: bool,
}

fn parse_args() -> Launch {
    let rest: Vec<String> = std::env::args().skip(1).collect();
    match rest.first().map(|s| s.as_str()) {
        Some("main") => {
            let url = rest.get(1).cloned();
            Launch {
                mode: Mode::Main,
                url: url.clone().unwrap_or_else(|| FALLBACK_MAIN_URL.into()),
                explicit: url.is_some(),
            }
        }
        Some("pet") => {
            let url = rest.get(1).cloned();
            Launch {
                mode: Mode::Pet,
                url: url.clone().unwrap_or_else(|| FALLBACK_PET_URL.into()),
                explicit: url.is_some(),
            }
        }
        // Kompatibel: panggilan lama langsung memberi URL pet tanpa kata "pet".
        Some(url) if url.starts_with("http") => Launch {
            mode: Mode::Pet,
            url: url.into(),
            explicit: true,
        },
        _ => Launch {
            mode: Mode::Main,
            url: FALLBACK_MAIN_URL.into(),
            explicit: false,
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

/// Apakah listener di host_port adalah server milik kita? Probe HTTP singkat
/// ke /api/mode dan cari kunci `"active"` khas JSON modeStatus(). Listener
/// asing (aplikasi lain yang kebetulan memakai port 8310) tidak akan
/// membalas dengan pola ini — tanpa cek ini, jendela pet bisa menampilkan
/// halaman aplikasi orang lain.
fn is_our_server(host_port: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect(host_port) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let req = format!("GET /api/mode HTTP/1.0\r\nHost: {host_port}\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let resp = String::from_utf8_lossy(&buf[..n]);
    resp.contains("HTTP/1") && resp.contains("\"active\"")
}

/// Beri kesempatan kedua: server milik kita yang baru dinyalakan (boot <1 dtk)
/// mungkin belum sempat membalas saat probe pertama.
fn is_our_server_with_retry(host_port: &str) -> bool {
    if is_our_server(host_port) {
        return true;
    }
    std::thread::sleep(Duration::from_millis(300));
    is_our_server(host_port)
}

/// Pilih port bila peluncuran tanpa argumen URL (dobel-klik shortcut):
///   1) port kosong → pakai (sidecar menyusul);
///   2) port berisi server MILIK KITA → pakai, menempel ke instance itu;
///   3) port diduduki aplikasi asing → geser ke kandidat berikutnya.
/// Semua kandidat gagal → kembali ke port dasar (perilaku lama).
fn pick_port() -> u16 {
    const BASE_PORT: u16 = 8310;
    const CANDIDATES: u16 = 10;
    for candidate in BASE_PORT..BASE_PORT + CANDIDATES {
        let hp = format!("127.0.0.1:{candidate}");
        if !can_connect(&hp) || is_our_server_with_retry(&hp) {
            return candidate;
        }
    }
    BASE_PORT
}

/// Server exe di samping shell (folder release portable). Tidak ada di layout
/// dev — di sana server dinyalakan start.bat / `bun run dev` secara terpisah.
fn sibling_server() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for name in ["live2d-agent.exe", "live2d-agent"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn main() {
    let mut launch = parse_args();
    // Tanpa argumen URL → shell memilih port sendiri (lihat pick_port).
    if !launch.explicit {
        let port = pick_port();
        launch.url = format!("http://127.0.0.1:{port}/");
    }
    let host_port = host_port_of(&launch.url);
    // Sidecar: folder portable — user dobel-klik shell, port masih kosong →
    // shell menyalakan exe server di sampingnya sendiri (PORT ikut URL arg).
    // Di layout dev sibling tidak ada, jadi perilaku lama (tunggu + recovery)
    // tetap berlaku.
    let server_child: Option<Child> = if !can_connect(&host_port) {
        match sibling_server() {
            Some(path) => {
                let port = host_port.rsplit(':').next().unwrap_or("8310").to_string();
                match Command::new(&path)
                    .env("PORT", &port)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(child) => {
                        eprintln!("[shell] sidecar server dinyalakan: {}", path.display());
                        Some(child)
                    }
                    Err(e) => {
                        eprintln!("[shell] gagal menyalakan sidecar: {e}");
                        None
                    }
                }
            }
            None => None,
        }
    } else {
        None
    };
    // Dibunuh saat aplikasi keluar supaya tidak menyisakan server yatim —
    // HANYA bila shell sendiri yang menyalakannya; bila server sudah jalan
    // dulu (start.bat / pet yang diluncurkan server), server_child kosong.
    let server_child = Arc::new(Mutex::new(server_child));
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
        .build(tauri::generate_context!())
        .expect("gagal menjalankan shell")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut guard) = server_child.lock() {
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
