//! LEGION — хост-сессия SDR: JSONL к tools/sdr_worker.py (SoapySDR).
//! ESP32 UART сюда не ходит.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

struct Session {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Result<String, String>>,
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
    // CARGO_MANIFEST_DIR = app/src-tauri → ../../tools
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

fn spawn_reader(stdout: std::process::ChildStdout) -> Receiver<Result<String, String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match r.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Err("worker закрыл stdout".into()));
                    break;
                }
                Ok(_) => {
                    let t = line.trim().to_string();
                    if !t.is_empty() && tx.send(Ok(t)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("read worker: {e}")));
                    break;
                }
            }
        }
    });
    rx
}

fn kill_session(slot: &mut Option<Session>) {
    if let Some(mut s) = slot.take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// Гарантированно живая сессия под УЖЕ взятым мьютексом.
/// Раньше ensure() лочил/отпускал SESSION, а rpc_line лочил снова — в окне
/// между ними соседний вызов по таймауту убивал сессию, и наш запрос падал
/// с «нет сессии SDR» вместо respawn (аудит №27).
fn ensure_locked(app: &AppHandle, guard: &mut Option<Session>) -> Result<(), String> {
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() {
            return Ok(());
        }
    }
    kill_session(guard);
    let script = worker_path(app)?;
    // stderr inherit: piped+нечитаемый stderr заполняет pipe (64 КБ) и вешает Soapy.
    let mut child = Command::new(python_bin())
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("запуск sdr_worker: {e}"))?;
    let stdin = child.stdin.take().ok_or("нет stdin worker")?;
    let stdout = child.stdout.take().ok_or("нет stdout worker")?;
    *guard = Some(Session {
        child,
        stdin,
        lines: spawn_reader(stdout),
    });
    Ok(())
}

fn rpc_line(app: &AppHandle, req: &str) -> Result<String, String> {
    let mut guard = SESSION.lock().map_err(|_| "sdr lock")?;
    ensure_locked(app, &mut guard)?;
    let s = guard.as_mut().ok_or("нет сессии SDR")?;
    writeln!(s.stdin, "{req}").map_err(|e| format!("write worker: {e}"))?;
    s.stdin.flush().map_err(|e| format!("flush worker: {e}"))?;
    match s.lines.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(line)) => Ok(line),
        Ok(Err(e)) => {
            kill_session(&mut *guard);
            Err(e)
        }
        Err(_) => {
            kill_session(&mut *guard);
            Err("timeout sdr_worker (15s) — Soapy/сеть зависли, процесс убит".into())
        }
    }
}

#[tauri::command]
pub async fn sdr_rpc(app: AppHandle, req: String) -> Result<String, String> {
    // Блокирующий recv до 15 с — в spawn_blocking, не на IPC-потоке.
    tauri::async_runtime::spawn_blocking(move || rpc_line(&app, &req))
        .await
        .map_err(|e| format!("sdr_rpc join: {e}"))?
}

const FLASH_BINS: &[&str] = &["bladeRF-cli", "uhd_image_loader", "hackrf_spiflash"];

/// Аргументы тоже по шаблону, не только argv[0]: фронт — единственный
/// источник, но allowlist на одном бинарнике без формы аргументов — дыра
/// (аудит №34). file обязан совпадать с параметром file.
fn args_ok(bin: &str, args: &[String], file: &str) -> bool {
    match bin {
        "bladeRF-cli" => {
            args.len() == 2 && ["-f", "-l", "-L"].contains(&args[0].as_str()) && args[1] == file
        }
        "hackrf_spiflash" => args.len() == 2 && args[0] == "-w" && args[1] == file,
        "uhd_image_loader" => {
            args.len() == 2
                && args[0].starts_with("--args=type=usrp2,addr=")
                && (args[1] == format!("--fpga-path={file}")
                    || args[1] == format!("--fw-path={file}"))
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn sdr_flash(argv: Vec<String>, file: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sdr_flash_blocking(argv, file))
        .await
        .map_err(|e| format!("sdr_flash join: {e}"))?
}

fn sdr_flash_blocking(argv: Vec<String>, file: Option<String>) -> Result<String, String> {
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
        let low = f.to_ascii_lowercase();
        if low.ends_with(".elf") || low.contains("esp32") {
            return Err("это похоже на прошивку ESP32 — на SDR не шьём".into());
        }
        if !args_ok(bin, &argv[1..], f) {
            return Err(format!("аргументы {bin} не по шаблону LEGION — отказ"));
        }
    } else {
        return Err("нет абсолютного пути к образу — CLI не ищет в cwd".into());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_templates() {
        let f = "/tmp/fw/hostedxA4.rbf";
        assert!(args_ok("bladeRF-cli", &["-l".into(), f.into()], f));
        assert!(args_ok("bladeRF-cli", &["-L".into(), f.into()], f));
        assert!(args_ok("bladeRF-cli", &["-f".into(), f.into()], f));
        // чужой файл / лишний флаг / другой бинарь — отказ
        assert!(!args_ok("bladeRF-cli", &["-l".into(), "/etc/passwd".into()], f));
        assert!(!args_ok("bladeRF-cli", &["-l".into(), f.into(), "--debug".into()], f));
        assert!(!args_ok("hackrf_spiflash", &["-w".into(), f.into()], "/other.bin"));
        assert!(args_ok("hackrf_spiflash", &["-w".into(), f.into()], f));
        assert!(args_ok(
            "uhd_image_loader",
            &["--args=type=usrp2,addr=192.168.10.2".into(), format!("--fw-path={f}")],
            f
        ));
        assert!(args_ok(
            "uhd_image_loader",
            &["--args=type=usrp2,addr=192.168.10.2".into(), format!("--fpga-path={f}")],
            f
        ));
        assert!(!args_ok(
            "uhd_image_loader",
            &["--args=type=usrp2,addr=192.168.10.2".into(), format!("--other={f}")],
            f
        ));
    }
}
