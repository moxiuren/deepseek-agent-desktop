//! DeepSeek-Agent one-click installer (Windows, single file, std only).
//!
//! Build with just rustc (no cargo needed):
//!   rustc -O install.rs -o install.exe
//! Run in a terminal:
//!   .\install.exe                 (install latest release with a .zip asset)
//!   .\install.exe --check-only    (verify this machine, change nothing)
//!   .\install.exe --tag v1.0.9    (pin a release tag)
//!   .\install.exe --zip C:\path\to.zip   (install from a local zip, no download)
//!   .\install.exe --no-launch     (install but do not start the app)
//!
//! Steps: winget/.NET8-desktop-runtime + WebView2 check (auto-install),
//! download newest release zip (prereleases included), stop app, timestamp
//! backup (pruned), extract, drop stale ThreadJob shell, seed user plugins
//! (missing files only), desktop + start-menu shortcuts, launch.
//! All console output is plain ASCII (no emoji): safe for legacy consoles.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const REPO: &str = "moxiuren/deepseek-agent-desktop";
const APP_DIR_NAME: &str = "DeepSeek-Agent";
const EXE_NAME: &str = "DeepSeek.exe";
const DOTNET_RUNTIME_NEEDLE: &str = "Microsoft.WindowsDesktop.App 8.";
const WV2_CLIENT_KEY: &str = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[derive(Default)]
struct Opts {
    tag: Option<String>,
    zip: Option<String>,
    dir: Option<String>,
    no_launch: bool,
    check_only: bool,
    keep_backups: usize,
}

fn usage() -> ! {
    eprintln!("usage: install.exe [--tag vX.Y.Z] [--zip PATH] [--dir PATH] [--no-launch] [--check-only] [--keep-backups N]");
    std::process::exit(1);
}

fn parse_args() -> Opts {
    let mut o = Opts { keep_backups: 3, ..Default::default() };
    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--tag" => { i += 1; if i >= args.len() { usage(); } o.tag = Some(args[i].clone()); }
            "--zip" => { i += 1; if i >= args.len() { usage(); } o.zip = Some(args[i].clone()); }
            "--dir" => { i += 1; if i >= args.len() { usage(); } o.dir = Some(args[i].clone()); }
            "--no-launch" => o.no_launch = true,
            "--check-only" => o.check_only = true,
            "--keep-backups" => {
                i += 1;
                if i >= args.len() { usage(); }
                o.keep_backups = args[i].parse().unwrap_or_else(|_| usage());
            }
            _ => usage(),
        }
        i += 1;
    }
    o
}

fn pass(msg: &str) { println!("[OK] {}", msg); }
fn step(msg: &str) { println!("[..] {}", msg); }
fn skip(msg: &str) { println!("[SKIP] {}", msg); }
fn fail(msg: &str) -> ! { eprintln!("[FAIL] {}", msg); std::process::exit(1); }

/// Run a program, return (success, combined output trimmed).
fn run(prog: &str, args: &[&str]) -> (bool, String) {
    match Command::new(prog).args(args).output() {
        Ok(out) => {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), s.trim().to_string())
        }
        Err(e) => (false, format!("spawn error: {}", e)),
    }
}

fn run_ps(script: &str) -> (bool, String) {
    run("powershell", &["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
}

fn have_winget() -> bool {
    run("winget", &["--version"]).0
}

fn dotnet_runtime_ok() -> bool {
    let (ok, out) = run("dotnet", &["--list-runtimes"]);
    ok && out.lines().any(|l| l.contains(DOTNET_RUNTIME_NEEDLE))
}

fn webview2_ok() -> bool {
    // Mirrors the C# bootstrapper registry check (HKLM first, then HKCU).
    let probe = format!(
        "(Test-Path 'HKLM:\\{}') -or (Test-Path 'HKCU:\\{}')",
        WV2_CLIENT_KEY, WV2_CLIENT_KEY
    );
    let (ok, out) = run_ps(&probe);
    ok && out.eq_ignore_ascii_case("true")
}

fn winget_install(id: &str, label: &str) -> bool {
    step(&format!("installing {} via winget ...", label));
    let (ok, out) = run(
        "winget",
        &[
            "install", "--id", id, "--silent",
            "--accept-package-agreements", "--accept-source-agreements",
        ],
    );
    if ok {
        pass(&format!("{} installed", label));
        true
    } else {
        eprintln!("[WARN] winget install {} failed: {}", id, head(&out, 300));
        false
    }
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn localappdata() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| fail("LOCALAPPDATA is not set"))
}

fn default_install_dir() -> PathBuf {
    localappdata().join(APP_DIR_NAME)
}

fn user_plugin_dir() -> PathBuf {
    let docs = env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
    Path::new(&docs).join("Documents").join(APP_DIR_NAME).join("plugins")
}

/// Split a JSON array body into top-level object strings (brace-depth walk).
fn split_objects(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    let mut in_str = false;
    let mut esc = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc { esc = false; }
            else if c == b'\\' { esc = true; }
            else if c == b'"' { in_str = false; }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'{' {
            if depth == 0 { start = Some(i); }
            depth += 1;
        } else if c == b'}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                if let Some(s) = start.take() { out.push(&body[s..=i]); }
            }
        }
        i += 1;
    }
    out
}

/// Extract "key":"value" (first occurrence, no unescaping beyond \\ and \").
fn str_field(obj: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\":\"", key);
    let p = obj.find(&pat)?;
    let mut s = String::new();
    let mut esc = false;
    for c in obj[p + pat.len()..].chars() {
        if esc {
            s.push(if c == '"' { '"' } else { c });
            esc = false;
        } else if c == '\\' {
            esc = true;
        } else if c == '"' {
            return Some(s);
        } else {
            s.push(c);
        }
    }
    None
}

fn num_field(obj: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{}\":", key);
    let p = obj.find(&pat)?;
    obj[p + pat.len()..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

struct Asset {
    tag: String,
    name: String,
    url: String,
    size: u64,
}

fn pick_asset(releases_json: &str) -> Option<Asset> {
    for rel in split_objects(releases_json) {
        let tag = str_field(&rel, "tag_name")?;
        let draft = rel.contains("\"draft\":true");
        if draft {
            continue;
        }
        // assets array: scan asset objects inside this release only.
        let apos = rel.find("\"assets\":[")?;
        let mut depth = 0usize;
        let mut end = apos;
        let rb = rel.as_bytes();
        let mut in_str = false;
        let mut esc = false;
        let mut i = apos;
        while i < rb.len() {
            let c = rb[i];
            if in_str {
                if esc { esc = false; }
                else if c == b'\\' { esc = true; }
                else if c == b'"' { in_str = false; }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'[' {
                depth += 1;
            } else if c == b']' {
                depth = depth.saturating_sub(1);
                if depth == 0 { end = i; break; }
            }
            i += 1;
        }
        let assets_body = &rel[apos..=end];
        for a in split_objects(assets_body) {
            let name = match str_field(a, "name") {
                Some(n) => n,
                None => continue,
            };
            let low = name.to_ascii_lowercase();
            if !low.ends_with(".zip") {
                continue;
            }
            if !(low.contains("win-x64") || low.contains("win64") || low.contains("trial")) {
                continue;
            }
            let url = match str_field(a, "browser_download_url") {
                Some(u) => u,
                None => continue,
            };
            let size = num_field(a, "size").unwrap_or(0);
            return Some(Asset { tag, name, url, size });
        }
    }
    None
}

fn fetch_releases(tag: Option<&str>) -> Result<String, String> {
    let url = match tag {
        Some(t) => format!("https://api.github.com/repos/{}/releases/tags/{}", REPO, t),
        None => format!("https://api.github.com/repos/{}/releases?per_page=20", REPO),
    };
    // Single release endpoint returns an object; wrap it so pick_asset sees an array.
    let wrap = tag.is_some();
    let ps = format!(
        "$ProgressPreference='SilentlyContinue'; \
         [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
         $r = Invoke-RestMethod -Uri '{}' -UseBasicParsing -Headers @{{'User-Agent'='deepseek-agent-installer'}}; \
         if ({}) {{ $r = @($r) }}; \
         $r | ConvertTo-Json -Depth 6 -Compress",
        url, if wrap { "$true" } else { "$false" }
    );
    let (ok, out) = run_ps(&ps);
    if !ok || out.is_empty() {
        return Err(format!("GitHub API query failed: {}", head(&out, 300)));
    }
    Ok(out)
}

fn download(url: &str, dest: &Path) -> Result<(), String> {
    let ps = format!(
        "$ProgressPreference='SilentlyContinue'; \
         Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
        url,
        dest.display()
    );
    let (ok, out) = run_ps(&ps);
    if !ok || !dest.exists() {
        return Err(format!("download failed: {}", head(&out, 300)));
    }
    Ok(())
}

fn epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn prune_backups(dir: &Path, keep: usize) {
    let mut baks: Vec<PathBuf> = Vec::new();
    let base = dir.parent().unwrap_or(Path::new("."));
    if let Ok(rd) = fs::read_dir(base) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                    if n.starts_with("backup-") {
                        baks.push(p);
                    }
                }
            }
        }
    }
    baks.sort();
    while baks.len() > keep {
        let old = baks.remove(0);
        match fs::remove_dir_all(&old) {
            Ok(_) => println!("[..] pruned old backup {}", old.display()),
            Err(e) => eprintln!("[WARN] prune {} failed: {}", old.display(), e),
        }
    }
}

fn make_shortcut(target: &Path, link: &Path, workdir: &Path) -> Result<(), String> {
    let ps = format!(
        "$w = New-Object -ComObject WScript.Shell; \
         $s = $w.CreateShortcut('{}'); \
         $s.TargetPath = '{}'; \
         $s.WorkingDirectory = '{}'; \
         $s.IconLocation = '{},0'; \
         $s.Save()",
        link.display(),
        target.display(),
        workdir.display(),
        target.display()
    );
    let (ok, out) = run_ps(&ps);
    if ok && link.exists() {
        Ok(())
    } else {
        Err(head(&out, 200))
    }
}

fn seed_plugins(install_dir: &Path) -> usize {
    let src = install_dir.join("plugins");
    let dst = user_plugin_dir();
    // Legacy blocklist: whale.js is superseded by whale-dsh.js and its
    // loader removes other whale widgets on sight; never (re)seed it.
    const SKIP: &[&str] = &["whale.js"];
    let mut copied = 0usize;
    let entries = fs::read_dir(&src).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default();
    if entries.is_empty() {
        return 0;
    }
    if fs::create_dir_all(&dst).is_err() {
        return 0;
    }
    for e in entries {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("js") {
            continue;
        }
        if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
            if SKIP.contains(&n) {
                continue;
            }
        }
        let target = dst.join(p.file_name().unwrap());
        if !target.exists() {
            if fs::copy(&p, &target).is_ok() {
                copied += 1;
            }
        }
    }
    copied
}

fn main() {
    let opts = parse_args();

    println!("DeepSeek-Agent one-click installer");
    println!("repo: {}", REPO);

    if !cfg!(windows) {
        fail("this installer supports Windows only");
    }

    // ---- 1. tooling ----
    step("checking powershell ...");
    if !run_ps("$PSVersionTable.PSVersion").0 {
        fail("powershell is not available");
    }
    pass("powershell ok");
    let winget = have_winget();
    if !winget {
        eprintln!("[WARN] winget not found; dependency auto-install disabled (install .NET 8 Desktop Runtime + WebView2 manually)");
    }

    // ---- 2. .NET 8 desktop runtime ----
    step("checking .NET 8 desktop runtime ...");
    if dotnet_runtime_ok() {
        pass(".NET 8 desktop runtime present");
    } else if opts.check_only {
        eprintln!("[FAIL] missing: .NET 8 Desktop Runtime");
    } else if winget {
        if !winget_install("Microsoft.DotNet.DesktopRuntime.8", ".NET 8 Desktop Runtime") || !dotnet_runtime_ok() {
            fail("could not install .NET 8 Desktop Runtime; install it manually and rerun");
        }
    } else {
        fail("missing .NET 8 Desktop Runtime and no winget to install it");
    }

    // ---- 3. WebView2 ----
    step("checking WebView2 runtime ...");
    if webview2_ok() {
        pass("WebView2 runtime present");
    } else if opts.check_only {
        eprintln!("[FAIL] missing: WebView2 runtime");
    } else if winget {
        if !winget_install("Microsoft.EdgeWebView2Runtime", "WebView2 runtime") || !webview2_ok() {
            fail("could not install WebView2 runtime; install it manually and rerun");
        }
    } else {
        fail("missing WebView2 runtime and no winget to install it");
    }

    // ---- 4. resolve package ----
    let install_dir = opts.dir.map(PathBuf::from).unwrap_or_else(default_install_dir);
    let zip_path: PathBuf;
    let label: String;
    if let Some(z) = &opts.zip {
        zip_path = PathBuf::from(z);
        if !zip_path.exists() {
            fail(&format!("local zip not found: {}", z));
        }
        label = format!("local {}", zip_path.display());
    } else {
        step("resolving latest release ...");
        let js = fetch_releases(opts.tag.as_deref()).unwrap_or_else(|e| fail(&e));
        let a = pick_asset(&js).unwrap_or_else(|| fail("no release with a win-x64/trial .zip asset found"));
        pass(&format!("release {} asset {} ({} bytes)", a.tag, a.name, a.size));
        label = format!("{} / {}", a.tag, a.name);
        if opts.check_only {
            println!("[OK] check-only: machine ready, package resolvable; nothing changed");
            return;
        }
        let tmp = env::temp_dir().join(&a.name);
        step(&format!("downloading {} ...", a.url));
        download(&a.url, &tmp).unwrap_or_else(|e| fail(&e));
        let got = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if a.size > 0 && got != a.size {
            fail(&format!("size mismatch: got {} want {}", got, a.size));
        }
        pass(&format!("downloaded {} bytes", got));
        zip_path = tmp;
    }
    if opts.check_only {
        println!("[OK] check-only: machine ready; nothing changed");
        return;
    }

    // ---- 5. stop running app ----
    step("stopping running DeepSeek.exe (if any) ...");
    let _ = run("taskkill", &["/F", "/IM", EXE_NAME]);
    std::thread::sleep(std::time::Duration::from_secs(2));

    // ---- 6. backup existing install ----
    if install_dir.exists() {
        let bak = install_dir.with_file_name(format!("backup-{}", epoch_secs()));
        step(&format!("backing up {} -> {}", install_dir.display(), bak.display()));
        if fs::rename(&install_dir, &bak).is_err() {
            fail("could not move existing install aside (is the app still running?)");
        }
        pass("backup done");
        prune_backups(&install_dir, opts.keep_backups);
    } else if let Some(p) = install_dir.parent() {
        let _ = fs::create_dir_all(p);
    }

    // ---- 7. extract ----
    step(&format!("extracting {} -> {}", zip_path.display(), install_dir.display()));
    let (okx, outx) = run_ps(&format!(
        "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
        zip_path.display(),
        install_dir.display()
    ));
    if !okx || !install_dir.join(EXE_NAME).exists() {
        fail(&format!("extract failed: {}", head(&outx, 300)));
    }
    pass("extracted");

    // ---- 8. drop stale ThreadJob rename-shell if the package carries one ----
    let stale = install_dir.join("Modules").join("ThreadJob");
    if stale.exists() {
        match fs::remove_dir_all(&stale) {
            Ok(_) => pass("removed stale Modules\\ThreadJob shell"),
            Err(e) => eprintln!("[WARN] could not remove stale shell: {}", e),
        }
    }

    // ---- 9. seed user plugins (missing only) ----
    let n = seed_plugins(&install_dir);
    if n > 0 {
        pass(&format!("seeded {} user plugin(s)", n));
    } else {
        skip("user plugins already present");
    }

    // ---- 10. shortcuts ----
    let exe = install_dir.join(EXE_NAME);
    let desktop = Path::new(&env::var("USERPROFILE").unwrap_or_default())
        .join("Desktop")
        .join("DeepSeek Agent.lnk");
    let startmenu = localappdata()
        .parent()
        .unwrap_or(Path::new("C:"))
        .join("Roaming")
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("DeepSeek Agent.lnk");
    match make_shortcut(&exe, &desktop, &install_dir) {
        Ok(_) => pass("desktop shortcut ready"),
        Err(e) => eprintln!("[WARN] desktop shortcut failed: {}", e),
    }
    match make_shortcut(&exe, &startmenu, &install_dir) {
        Ok(_) => pass("start-menu shortcut ready"),
        Err(e) => eprintln!("[WARN] start-menu shortcut failed: {}", e),
    }

    // ---- 11. launch ----
    if !opts.no_launch {
        step("launching ...");
        match Command::new(&exe).spawn() {
            Ok(_) => pass("launched"),
            Err(e) => eprintln!("[WARN] launch failed (start it manually): {}", e),
        }
    }

    println!("[DONE] installed {} -> {}", label, install_dir.display());
}
