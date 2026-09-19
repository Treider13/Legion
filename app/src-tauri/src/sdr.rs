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

/// python3 из PATH часто venv или deadsnakes — там нет apt-пакета python3-soapysdr.
/// Сначала системный интерпретатор, у которого `import SoapySDR` проходит.
/// Принудительно: LEGION_PYTHON=/usr/bin/python3
fn python_bin() -> PathBuf {
    resolve_python(std::env::var("LEGION_PYTHON").ok().as_deref())
}

fn python_imports(bin: &Path, module: &str) -> bool {
    Command::new(bin)
        .args(["-c", &format!("import {module}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn resolve_python(override_bin: Option<&str>) -> PathBuf {
    if let Some(p) = override_bin.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(p);
    }
    let mut cands: Vec<PathBuf> = vec![PathBuf::from("/usr/bin/python3")];
    for name in [
        "python3",
        "python3.14",
        "python3.13",
        "python3.12",
        "python3.11",
        "python",
    ] {
        if let Some(p) = which(name) {
            cands.push(p);
        }
    }
    let mut seen = std::collections::HashSet::new();
    for c in cands {
        if !seen.insert(c.clone()) {
            continue;
        }
        if python_imports(&c, "SoapySDR") {
            return c;
        }
    }
    which("python3").unwrap_or_else(|| PathBuf::from("python3"))
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

fn iperf_host_ok(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    h.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_'))
        && !h.starts_with('-')
}

fn iperf_bitrate_ok(b: &str) -> bool {
    let s = b.trim();
    if s.is_empty() || s.len() > 12 {
        return false;
    }
    let (num, suf) = match s.chars().last() {
        Some(c) if c.is_ascii_alphabetic() => (&s[..s.len() - 1], c),
        _ => (s, ' '),
    };
    if !matches!(suf, ' ' | 'k' | 'K' | 'm' | 'M' | 'g' | 'G') {
        return false;
    }
    num.parse::<f64>().ok().is_some_and(|v| v > 0.0 && v <= 10_000.0)
}

/// Официальный `iperf3 --json`. Не shell, не чужие флаги. Нет бинаря / нет сервера — отказ.
#[tauri::command]
pub async fn lab_iperf3(
    host: String,
    port: u16,
    time_sec: u32,
    udp: bool,
    bitrate: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || lab_iperf3_blocking(host, port, time_sec, udp, bitrate))
        .await
        .map_err(|e| format!("iperf3 join: {e}"))?
}

fn lab_iperf3_blocking(
    host: String,
    port: u16,
    time_sec: u32,
    udp: bool,
    bitrate: Option<String>,
) -> Result<String, String> {
    if !iperf_host_ok(&host) {
        return Err("iperf3: хост не похож на имя/IP — CLI не запущен".into());
    }
    if port == 0 {
        return Err("iperf3: порт 1…65535".into());
    }
    if !(1..=30).contains(&time_sec) {
        return Err("iperf3: время 1…30 с".into());
    }
    if which("iperf3").is_none() {
        return Err("iperf3 не найден в PATH — отчёт не выдумываем".into());
    }
    let mut args: Vec<String> = vec![
        "--json".into(),
        "-c".into(),
        host.trim().into(),
        "-p".into(),
        port.to_string(),
        "-t".into(),
        time_sec.to_string(),
    ];
    if udp {
        args.push("-u".into());
        let b = bitrate.unwrap_or_else(|| "1M".into());
        if !iperf_bitrate_ok(&b) {
            return Err("iperf3: -b только число с суффиксом k/M/G".into());
        }
        args.push("-b".into());
        args.push(b);
    } else if let Some(b) = bitrate {
        if !iperf_bitrate_ok(&b) {
            return Err("iperf3: -b только число с суффиксом k/M/G".into());
        }
        args.push("-b".into());
        args.push(b);
    }
    let timeout = Duration::from_secs(u64::from(time_sec) + 8);
    let mut child = Command::new("iperf3")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск iperf3: {e}"))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    use std::io::Read;
                    let _ = out.read_to_string(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_string(&mut stderr);
                }
                if !status.success() {
                    return Err(format!(
                        "iperf3 exit {}: {}",
                        status.code().unwrap_or(-1),
                        stderr.trim().chars().take(240).collect::<String>()
                    ));
                }
                if stdout.trim().is_empty() {
                    return Err("iperf3: пустой stdout — это не --json".into());
                }
                return Ok(stdout);
            }
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                return Err("iperf3: таймаут — сервер не ответил, цифры нет".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("iperf3 wait: {e}")),
        }
    }
}

#[tauri::command]
pub fn sdr_host_info() -> Result<serde_json::Value, String> {
    let py = python_bin();
    Ok(serde_json::json!({
        "hasBladeRfCli": which("bladeRF-cli").is_some(),
        "hasUhdLoader": which("uhd_image_loader").is_some(),
        "hasHackrfFlash": which("hackrf_spiflash").is_some(),
        "hasSoapyUtil": which("SoapySDRUtil").is_some(),
        "python": py.to_string_lossy(),
        "hasSoapyPython": python_imports(&py, "SoapySDR"),
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

    #[test]
    fn python_override_wins() {
        assert_eq!(
            resolve_python(Some("/opt/legion/python3")),
            PathBuf::from("/opt/legion/python3")
        );
        assert_eq!(resolve_python(Some("  ")).file_name().is_some(), true);
    }

    #[test]
    fn iperf_allowlist() {
        assert!(iperf_host_ok("192.168.1.10"));
        assert!(iperf_host_ok("lab-iperf.local"));
        assert!(!iperf_host_ok(""));
        assert!(!iperf_host_ok("host;rm -rf /"));
        assert!(!iperf_host_ok("-evil"));
        assert!(iperf_bitrate_ok("1M"));
        assert!(iperf_bitrate_ok("10"));
        assert!(!iperf_bitrate_ok("1;id"));
        assert!(!iperf_bitrate_ok(""));
    }
}
