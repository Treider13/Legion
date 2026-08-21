//! LEGION — хост-сессия SDR: JSONL к tools/sdr_worker.py (SoapySDR).
//! ESP32 UART сюда не ходит.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn worker_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LEGION_SDR_WORKER") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("../../tools/sdr_worker.py");
    if dev.exists() {
        return Ok(dev);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("sdr_worker.py");
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    Err("sdr_worker.py не найден (tools/ или LEGION_SDR_WORKER)".into())
}

fn python_bin() -> &'static str {
    if Command::new("python3").arg("-c").arg("1").output().is_ok() {
        "python3"
    } else {
        "python"
    }
}

fn ensure(app: &AppHandle) -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|_| "sdr lock")?;
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() {
            return Ok(());
        }
    }
    let script = worker_path(app)?;
    let mut child = Command::new(python_bin())
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск sdr_worker: {e}"))?;
    let stdin = child.stdin.take().ok_or("нет stdin worker")?;
    let stdout = child.stdout.take().ok_or("нет stdout worker")?;
    *guard = Some(Session {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    });
    Ok(())
}

fn rpc_line(app: &AppHandle, req: &str) -> Result<String, String> {
    ensure(app)?;
    let mut guard = SESSION.lock().map_err(|_| "sdr lock")?;
    let s = guard.as_mut().ok_or("нет сессии SDR")?;
    writeln!(s.stdin, "{req}").map_err(|e| format!("write worker: {e}"))?;
    s.stdin.flush().map_err(|e| format!("flush worker: {e}"))?;
    let start = Instant::now();
    let mut line = String::new();
    loop {
        line.clear();
        let n = s
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("read worker: {e}"))?;
        if n == 0 {
            return Err("worker закрыл stdout".into());
        }
        let t = line.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
        if start.elapsed() > Duration::from_secs(12) {
            return Err("timeout sdr_worker".into());
        }
    }
}

#[tauri::command]
pub fn sdr_rpc(app: AppHandle, req: String) -> Result<String, String> {
    rpc_line(&app, &req)
}

const FLASH_BINS: &[&str] = &["bladeRF-cli", "uhd_image_loader", "hackrf_spiflash"];

#[tauri::command]
pub fn sdr_flash(argv: Vec<String>, file: Option<String>) -> Result<String, String> {
    if argv.is_empty() {
        return Err("нет команды прошивки (Pluto — mass-storage вручную)".into());
    }
    let bin = argv[0].as_str();
    if !FLASH_BINS.contains(&bin) {
        return Err(format!("запрещённый бинарь прошивки: {bin}"));
    }
    if which(bin).is_none() {
        return Err(format!("{bin} не найден в PATH — образ не записан"));
    }
    if let Some(ref f) = file {
        if !Path::new(f).is_file() {
            return Err(format!("файл образа не найден: {f}"));
        }
    }
    let out = Command::new(bin)
        .args(&argv[1..])
        .output()
        .map_err(|e| format!("запуск {bin}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("записано: {stdout}{stderr}"))
    } else {
        Err(format!(
            "{bin} exit {}: {stdout}{stderr}",
            out.status.code().unwrap_or(-1)
        ))
    }
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(bin);
        if cand.is_file() {
            return Some(cand);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{bin}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

#[tauri::command]
pub fn sdr_host_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "hasBladeRfCli": which("bladeRF-cli").is_some(),
        "hasUhdLoader": which("uhd_image_loader").is_some(),
        "hasHackrfFlash": which("hackrf_spiflash").is_some(),
        "hasSoapyUtil": which("SoapySDRUtil").is_some(),
    }))
}
