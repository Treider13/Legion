//! Разбор ELRS из основного окна. Python без своего экрана, статус — строка JSON.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

struct RxJob {
    child: Child,
    last: Arc<Mutex<String>>,
    err: Arc<Mutex<String>>,
}

static RX: Mutex<Option<RxJob>> = Mutex::new(None);

fn repo_root() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LEGION_REPO_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.join("host/legion_rx/main_app.py").is_file() {
            return Ok(pb);
        }
        return Err(format!("LEGION_REPO_ROOT={p}: нет host/legion_rx"));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if dev.join("host/legion_rx/main_app.py").is_file() {
        return Ok(dev);
    }
    Err("нет host/legion_rx — приложение собрано не из каталога Legion".into())
}

fn rx_python(root: &Path) -> PathBuf {
    let venv = root.join(".venv/bin/python");
    if venv.is_file() {
        venv
    } else {
        PathBuf::from("python3")
    }
}

fn capture_name_ok(name: &str) -> bool {
    !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.starts_with("elrs_")
        && name.ends_with(".json")
}

fn spawn_rx(
    from_log: bool,
    live: bool,
    f_start_hz: f64,
    f_end_hz: f64,
    jam_duration_s: f64,
    mute_ns: i64,
    lna_gain_db: f64,
    shift_hz: f64,
    look_every_ms: f64,
    look_for_ms: f64,
    survey: bool,
) -> Result<(), String> {
    let mut guard = RX.lock().map_err(|_| "rx lock")?;
    if let Some(job) = guard.as_mut() {
        if job.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("разбор уже идёт".into());
        }
    }
    let root = repo_root()?;
    let mode = if from_log { "--run" } else if live { "--live" } else { "--test" };
    let mut cmd = Command::new(rx_python(&root));
    cmd.arg("-m")
        .arg("host.legion_rx.main_app")
        .arg(mode)
        .arg("--f-start")
        .arg(f_start_hz.to_string())
        .arg("--f-end")
        .arg(f_end_hz.to_string())
        .arg("--jam")
        .arg(jam_duration_s.to_string())
        .arg("--mute")
        .arg(mute_ns.to_string())
        .arg("--lna")
        .arg(lna_gain_db.to_string())
        .arg("--shift-hz")
        .arg(shift_hz.to_string())
        .arg("--look-every-ms")
        .arg(look_every_ms.to_string())
        .arg("--look-for-ms")
        .arg(look_for_ms.to_string());
    if survey {
        cmd.arg("--survey");
    }
    let mut child = cmd
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск разбора: {e}"))?;
    let stdout = child.stdout.take().ok_or("нет stdout")?;
    let stderr = child.stderr.take().ok_or("нет stderr")?;
    let last = Arc::new(Mutex::new(String::new()));
    let err = Arc::new(Mutex::new(String::new()));
    let last_bg = Arc::clone(&last);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut slot) = last_bg.lock() {
                *slot = line;
            }
        }
    });
    let err_bg = Arc::clone(&err);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut slot) = err_bg.lock() {
                if slot.len() > 800 {
                    slot.drain(..400);
                }
                slot.push_str(&line);
                slot.push('\n');
            }
        }
    });
    *guard = Some(RxJob { child, last, err });
    Ok(())
}

#[tauri::command]
pub async fn legion_rx_digital_start(job: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || spawn_digital(job))
        .await
        .map_err(|e| format!("цифровой: {e}"))?
}

fn spawn_digital(job: serde_json::Value) -> Result<(), String> {
    let mut guard = RX.lock().map_err(|_| "rx lock")?;
    if let Some(running) = guard.as_mut() {
        if running.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("разбор уже идёт".into());
        }
    }
    let root = repo_root()?;
    let path = root.join("host/legion_rx/digital_job.json");
    let text = serde_json::to_string_pretty(&job).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("запись задания: {e}"))?;
    let corridors = job.get("corridors").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let first = corridors.first();
    let f_start = first
        .and_then(|c| c.get("start_hz"))
        .and_then(|v| v.as_f64())
        .unwrap_or(2.4e9);
    let f_end = first
        .and_then(|c| c.get("end_hz"))
        .and_then(|v| v.as_f64())
        .unwrap_or(f_start + 56e6);
    let mut cmd = Command::new(rx_python(&root));
    cmd.arg("-m")
        .arg("host.legion_rx.main_app")
        .arg("--digital")
        .arg("--f-start")
        .arg(f_start.to_string())
        .arg("--f-end")
        .arg(f_end.to_string())
        .arg("--jam")
        .arg("0")
        .arg("--mute")
        .arg("0")
        .arg("--lna")
        .arg("20");
    let mut child = cmd
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск цифрового: {e}"))?;
    let stdout = child.stdout.take().ok_or("нет stdout")?;
    let stderr = child.stderr.take().ok_or("нет stderr")?;
    let last = Arc::new(Mutex::new(String::new()));
    let err = Arc::new(Mutex::new(String::new()));
    let last_bg = Arc::clone(&last);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut slot) = last_bg.lock() {
                *slot = line;
            }
        }
    });
    let err_bg = Arc::clone(&err);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut slot) = err_bg.lock() {
                if slot.len() > 800 {
                    slot.drain(..400);
                }
                slot.push_str(&line);
                slot.push('\n');
            }
        }
    });
    *guard = Some(RxJob { child, last, err });
    Ok(())
}

#[tauri::command]
pub async fn legion_rx_test_start(
    f_start_hz: f64,
    f_end_hz: f64,
    jam_duration_s: f64,
    mute_ns: i64,
    lna_gain_db: f64,
    from_log: bool,
    live: Option<bool>,
    shift_hz: Option<f64>,
    look_every_ms: Option<f64>,
    look_for_ms: Option<f64>,
    survey: Option<bool>,
) -> Result<(), String> {
    let live = live.unwrap_or(false);
    let shift_hz = shift_hz.unwrap_or(15_000.0);
    let look_every_ms = look_every_ms.unwrap_or(100.0);
    let look_for_ms = look_for_ms.unwrap_or(2.0);
    let survey = survey.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        spawn_rx(
            from_log,
            live,
            f_start_hz,
            f_end_hz,
            jam_duration_s,
            mute_ns,
            lna_gain_db,
            shift_hz,
            look_every_ms,
            look_for_ms,
            survey,
        )
    })
    .await
    .map_err(|e| format!("разбор: {e}"))?
}

#[tauri::command]
pub fn legion_rx_test_status() -> Result<serde_json::Value, String> {
    let mut guard = RX.lock().map_err(|_| "rx lock")?;
    let Some(job) = guard.as_mut() else {
        return Ok(serde_json::json!({"running": false, "line": "", "err": ""}));
    };
    let exit = job.child.try_wait().map_err(|e| e.to_string())?;
    let running = exit.is_none();
    let line = job.last.lock().map_err(|_| "rx lock")?.clone();
    let err = job.err.lock().map_err(|_| "rx lock")?.clone();
    Ok(serde_json::json!({
        "running": running,
        "exit": exit.and_then(|s| s.code()),
        "line": line,
        "err": err,
    }))
}

#[tauri::command]
pub fn legion_rx_prime(
    f_start_hz: f64,
    f_end_hz: f64,
    hops_mhz: Vec<f64>,
    dwell_us: Option<u32>,
) -> Result<(), String> {
    if !f_start_hz.is_finite() || !f_end_hz.is_finite() || f_end_hz <= f_start_hz {
        return Err("коридор участка пуст".into());
    }
    if hops_mhz.is_empty() || hops_mhz.len() > 256 {
        return Err("прыжков должно быть от 1 до 256".into());
    }
    let dwell = dwell_us.unwrap_or(1000).clamp(1, 1_000_000);
    let dwell_s = f64::from(dwell) / 1e6;
    let freqs: Vec<f64> = hops_mhz.into_iter().take(256).collect();
    let n = freqs.len();
    let cycle: Vec<u32> = (0..n as u32).collect();
    let record = serde_json::json!({
        "pattern_id": "accepted-corridor",
        "sub_corridor_id": "accepted",
        "sub": {
            "f_start": f_start_hz,
            "f_end": f_end_hz,
            "sub_corridor_id": "accepted"
        },
        "freqs_mhz": freqs,
        "hop_sequence": cycle,
        "cycle": cycle,
        "cycle_length": n,
        "dwell_us": dwell,
        "dwell_s": dwell_s
    });
    let body = serde_json::json!({
        "record": record,
        "note": "принятый коридор",
        "file": "ui"
    });
    let path = repo_root()?.join("host/legion_rx/replay_pending.json");
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("запись паттерна: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn legion_rx_test_stop() -> Result<(), String> {
    let mut guard = RX.lock().map_err(|_| "rx lock")?;
    let Some(job) = guard.as_mut() else {
        return Ok(());
    };
    let mut finished = job.child.try_wait().ok().flatten().is_some();
    if !finished {
        let pid = job.child.id().to_string();
        let _ = Command::new("kill").args(["-TERM", &pid]).status();
        finished = job.child.wait_timeout_ms(2500);
    }
    if !finished {
        let _ = job.child.kill();
        let _ = job.child.wait();
    }
    Ok(())
}

trait WaitTimeout {
    fn wait_timeout_ms(&mut self, ms: u64) -> bool;
}

impl WaitTimeout for Child {
    fn wait_timeout_ms(&mut self, ms: u64) -> bool {
        let steps = ms / 50;
        for _ in 0..steps {
            if self.try_wait().ok().flatten().is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.try_wait().ok().flatten().is_some()
    }
}

#[tauri::command]
pub fn legion_rx_captures() -> Result<Vec<String>, String> {
    let dir = repo_root()?.join("host/tests/captures");
    let mut names = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(names),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if capture_name_ok(&name) {
            names.push(name);
        }
    }
    names.sort();
    names.reverse();
    Ok(names)
}

#[tauri::command]
pub async fn legion_rx_load(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || load_capture(&name))
        .await
        .map_err(|e| format!("загрузка: {e}"))?
}

fn load_capture(name: &str) -> Result<String, String> {
    if !capture_name_ok(name) {
        return Err("нужен файл elrs_….json из папки тестов".into());
    }
    let root = repo_root()?;
    let path = root.join("host/tests/captures").join(name);
    if !path.is_file() {
        return Err("файла нет".into());
    }
    let out = Command::new(rx_python(&root))
        .arg("-m")
        .arg("host.legion_rx.main_app")
        .arg("--load")
        .arg(&path)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("загрузка: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if text.is_empty() { err.trim().to_string() } else { text });
    }
    Ok(text)
}
