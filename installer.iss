; installer.iss — Inno Setup untuk Live2D Agent (Windows).
;
; Membungkus isi dist/Live2D-Agent/ (hasil `bun run dist`) menjadi SATU file
; setup: dist/Live2D-Agent-Setup.exe — user download, dobel-klik, selesai.
;
; Build manual:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
; atau otomatis dari dist.ts (langkah terakhir `bun run dist`) bila ISCC ada.
;
; Keputusan penting:
;   - PrivilegesRequired=lowest → {autopf} memetakan ke
;     %LOCALAPPDATA%\Programs\Live2D-Agent (per-user, tanpa UAC, pasti
;     writable) sehingga kontrak "data/ di samping exe" tetap berlaku tanpa
;     mengubah kode. Sengaja TIDAK pakai PrivilegesRequiredOverridesAllowed —
;     instalasi ke Program Files akan mematikan penulisan data/config.json.
;   - data/ (API key, sheet, preset, model) dibuat runtime di samping exe dan
;     sengaja TIDAK terdaftar di [Files] maupun [UninstallDelete] — uninstall
;     harus membiarkan data user utuh.
;   - WebView2 sudah bawaan Windows 10/11; installer hanya memperingatkan
;     (dan menawarkan membuka halaman unduhan) bila runtime tidak ditemukan.

#define MyAppName "Live2D Agent"
#define MyAppExeName "live2d-shell.exe"

#ifndef APP_VERSION
  #define APP_VERSION "2.0.0"
#endif

[Setup]
AppId={{B7F4A2E9-3C8D-4E61-9F5B-2A7D1C0E8F34}
AppName={#MyAppName}
AppVersion={#APP_VERSION}
AppPublisher=Live2D Agent
DefaultDirName={autopf}\Live2D-Agent
PrivilegesRequired=lowest
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=Live2D-Agent-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Satu baris wildcard — isi dist/Live2D-Agent/ utuh: 2 exe + static/ + BACA-SAYA.txt
Source: "dist\Live2D-Agent\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  // GUID produk WebView2 Evergreen (kunci resmi milik Microsoft EdgeUpdate)
  WebView2Key = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed(): Boolean;
var
  pv: String;
begin
  Result := False;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\' + WebView2Key, 'pv', pv) or
     RegQueryStringValue(HKLM, WebView2Key, 'pv', pv) or
     RegQueryStringValue(HKCU, WebView2Key, 'pv', pv) then
    Result := (pv <> '') and (pv <> '0.0.0.0') and (pv <> '0.0.0.1');
end;

function InitializeSetup(): Boolean;
var
  ec: Integer;
begin
  Result := True;
  if not WebView2Installed() then
  begin
    if MsgBox(
      'Windows WebView2 runtime tidak ditemukan di komputer ini.' + #13#10 +
      'Live2D Agent membutuhkannya untuk menampilkan jendela aplikasi' + #13#10 +
      '(biasanya sudah bawaan Windows 10/11).' + #13#10#13#10 +
      'Lanjutkan instalasi dan buka halaman unduhan WebView2 sekarang?',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, ec);
    end;
    // Tetap lanjut instalasi — user mungkin memasang runtime belakangan.
  end;
end;
