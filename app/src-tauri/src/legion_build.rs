//! LEGION — сборка ревизии legion из fpga/ (Quartus на стенде) и артефакт .rbf.
//! Не sdr_rpc (таймаут 15 с) и не sdr_flash (allowlist из трёх CLI вендоров):
//! синтез Quartus долгий (ориентир — десятки минут, точной цифры в дереве
//! Nuand нет), лог пишется в файл, UI опрашивает статус и читает хвост.
//!
//! Факты, на которые опирается модуль:
//!   - сборка: fpga/vendor/bladerf/hdl/quartus/build_bladerf.sh -b <board> -s <size> -r legion
//!     из окружения nios2_command_shell.sh (~/intelFPGA_lite/<ver>/nios2eds/);
//!   - артефакт: <quartus>/legionx<size>-<дата>/legionx<size>.rbf + .rbf.sha256sum
//!     (build_bladerf.sh: BUILD_NAME="$rev"x"$size", omit_date=false по умолчанию);
//!   - preflight: fpga/check_toolchain.sh (пин Quartus 23.1.1 — vendored hdl/README.md).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

struct BuildState {
    child: Child,
    log_path: PathBuf,
    quartus_dir: PathBuf,
    size: String,
    started: SystemTime,
}

static BUILD: Mutex<Option<BuildState>> = Mutex::new(None);

/// Таблица плат — зеркало app/src/flash/legionCustom.ts (LEGION_BOARDS).
/// Только эти пары board/size: A2/A5 и x115 в каталоге LEGION нет.
fn board_args_ok(board: &str, size: &str) -> bool {
    matches!(
        (board, size),
        ("bladeRF", "40") | ("bladeRF-micro", "A4") | ("bladeRF-micro", "A9")
    )
}

/// build_bladerf.sh: BUILD_NAME="$rev"x"$size" → legionx40 / legionxA4 / legionxA9.
fn rbf_base(size: &str) -> String {
    format!("legionx{size}")
}

fn quartus_dir_of(root: &Path) -> PathBuf {
    root.join("fpga/vendor/bladerf/hdl/quartus")
}

/// Корень репозитория: LEGION_REPO_ROOT или dev-layout (src-tauri/../../).
/// В установленном бандле fpga/ нет (tauri.conf.json resources) — честный отказ.
fn repo_root() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LEGION_REPO_ROOT") {
        let pb = PathBuf::from(p.trim());
        if quartus_dir_of(&pb).join("build_bladerf.sh").is_file() {
            return Ok(pb);
        }
        return Err(format!(
            "LEGION_REPO_ROOT={p}: нет fpga/vendor/bladerf/hdl/quartus/build_bladerf.sh"
        ));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if quartus_dir_of(&dev).join("build_bladerf.sh").is_file() {
        return Ok(dev);
    }
    Err("дерево fpga/ не найдено: сборка возможна из checkout репозитория \
         (или задайте LEGION_REPO_ROOT). В установщике исходников FPGA нет"
        .into())
}

/// nios2_command_shell.sh — как в fpga/check_toolchain.sh:
/// $HOME/intelFPGA_lite/<ver>/nios2eds/nios2_command_shell.sh.
/// При нескольких установках предпочитаем пин 23.1 (вендоренный hdl/README.md),
/// иначе — последнюю по сортировке.
fn pick_nios_shell(mut found: Vec<PathBuf>) -> Option<PathBuf> {
    found.sort();
    let pinned = found
        .iter()
        .position(|p| p.to_string_lossy().contains("intelFPGA_lite/23.1"));
    match pinned {
        Some(i) => Some(found.remove(i)),
        None => found.pop(),
    }
}

fn nios_shell() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = PathBuf::from(home).join("intelFPGA_lite");
    let found: Vec<PathBuf> = fs::read_dir(base)
        .ok()?
        .flatten()
        .map(|e| e.path().join("nios2eds/nios2_command_shell.sh"))
        .filter(|p| p.is_file())
        .collect();
    pick_nios_shell(found)
}

#[tauri::command]
pub fn legion_env_info() -> serde_json::Value {
    let os = std::env::consts::OS;
    let root = repo_root();
    let shell = nios_shell();
    let (can, reason) = if os != "linux" {
        (false, format!("сборка FPGA — Linux-стенд (Quartus + nios2_command_shell.sh); здесь {os}"))
    } else if let Err(e) = &root {
        (false, e.clone())
    } else if shell.is_none() {
        (
            false,
            "nios2_command_shell.sh не найден (~/intelFPGA_lite/*/nios2eds/) — поставьте Quartus Prime Lite 23.1.1"
                .to_string(),
        )
    } else {
        (true, "стенд сборки готов (репозиторий + NIOS II shell)".to_string())
    };
    serde_json::json!({
        "os": os,
        "repoRoot": root.as_ref().ok().map(|p| p.to_string_lossy().to_string()),
        "quartusDir": root.as_ref().ok().map(|p| quartus_dir_of(p).to_string_lossy().to_string()),
        "niosShell": shell.map(|p| p.to_string_lossy().to_string()),
        "canBuild": can,
        "reason": reason,
    })
}

#[tauri::command]
pub async fn legion_toolchain_check() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root()?;
        let script = root.join("fpga/check_toolchain.sh");
        let mut cmd = Command::new("bash");
        cmd.arg(script);
        let out = run_limited(cmd, Duration::from_secs(60), "check_toolchain")?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("legion_toolchain_check join: {e}"))?
}

fn run_limited(mut cmd: Command, timeout: Duration, label: &str) -> Result<String, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск {label}: {e}"))?;
    // Дренаж параллельно, не после exit: иначе вывод > 64 КБ заполнил бы pipe
    // и повесил дочерний процесс до таймаута (паттерн drain в esp32_flash.rs).
    fn drain(pipe: impl std::io::Read + Send + 'static) -> std::sync::mpsc::Receiver<String> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let mut r = pipe;
            let _ = std::io::Read::read_to_string(&mut r, &mut buf);
            let _ = tx.send(buf);
        });
        rx
    }
    let out_rx = child.stdout.take().map(drain);
    let err_rx = child.stderr.take().map(drain);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{label}: timeout {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("{label}: {e}")),
        }
    };
    let stdout = out_rx
        .and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok())
        .unwrap_or_default();
    let stderr = err_rx
        .and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok())
        .unwrap_or_default();
    let text = format!("{stdout}{stderr}");
    if status.success() {
        Ok(text)
    } else {
        Err(format!("{label} exit {}: {text}", status.code().unwrap_or(-1)))
    }
}

#[tauri::command]
pub async fn legion_build_start(board: String, size: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || legion_build_start_blocking(&board, &size))
        .await
        .map_err(|e| format!("legion_build_start join: {e}"))?
}

fn legion_build_start_blocking(board: &str, size: &str) -> Result<serde_json::Value, String> {
    if !board_args_ok(board, size) {
        return Err(format!("плата {board}/{size} вне таблицы legion (bladeRF 40, bladeRF-micro A4/A9)"));
    }
    if std::env::consts::OS != "linux" {
        return Err("сборка FPGA — Linux-стенд: nios2_command_shell.sh + build_bladerf.sh".into());
    }
    let root = repo_root()?;
    let quartus = quartus_dir_of(&root);
    let shell = nios_shell()
        .ok_or("nios2_command_shell.sh не найден — сначала Quartus Prime Lite 23.1.1")?;

    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let log_path = std::env::temp_dir().join(format!("legion-build-{size}-{ts}.log"));
    let log_out = fs::File::create(&log_path).map_err(|e| format!("лог сборки: {e}"))?;
    let log_err = log_out.try_clone().map_err(|e| format!("лог сборки: {e}"))?;

    // Авто-запуск команды — документированная форма Nios II Command Shell
    // (Nios II Software Developer's Handbook, «Auto-Executing a Command»:
    // nios2_command_shell.sh <command>; скрипт делает exec "$@" — подтверждено
    // и сообщением «exec: make: not found» при вызове с аргументами, Altera
    // Community #259066). setsid: своя группа процессов — ОТМЕНА бьёт по
    // группе (quartus_sh и nios2-make — дети build_bladerf.sh).
    // board/size — из allowlist board_args_ok, путь — из репозитория: интерполяция
    // в bash -c безопасна (внешних строк нет).
    let script = format!(
        "cd \"{}\" && ./build_bladerf.sh -b {board} -s {size} -r legion; ec=$?; echo LEGION_BUILD_EXIT=$ec; exit $ec",
        quartus.to_string_lossy()
    );
    let mut cmd = Command::new("setsid");
    cmd.arg(&shell)
        .arg("bash")
        .arg("-c")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_out))
        .stderr(Stdio::from(log_err));

    // Один лок на проверку «уже идёт» + spawn + запись: иначе два старта
    // подряд проскочили бы проверку и второй затёр бы первый процесс.
    let mut guard = BUILD.lock().map_err(|_| "build lock")?;
    if let Some(st) = guard.as_mut() {
        // Завершившаяся сборка, которую никто не опросил, не блокирует новую.
        match st.child.try_wait() {
            Ok(None) => return Err("сборка уже идёт — дождитесь конца или ОТМЕНА".into()),
            _ => *guard = None,
        }
    }
    let child = cmd.spawn().map_err(|e| format!("запуск nios2_command_shell: {e}"))?;
    *guard = Some(BuildState {
        child,
        log_path: log_path.clone(),
        quartus_dir: quartus,
        size: size.to_string(),
        started: SystemTime::now(),
    });
    Ok(serde_json::json!({
        "ok": true,
        "logPath": log_path.to_string_lossy(),
        "cmd": format!("build_bladerf.sh -b {board} -s {size} -r legion"),
    }))
}

/// Хвост лога сборки (последние max байт) — UI показывает прогресс Quartus.
/// Читаем только хвост (seek): полный лог синтеза — десятки МБ, опрос каждые 2 с.
fn log_tail(path: &Path, max: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max as u64);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// Каталог артефакта: legionx<size> или legionx<size>-<дата> (omit_date=false).
fn artifact_dir_matches(name: &str, base: &str) -> bool {
    name == base || (name.starts_with(base) && name.as_bytes().get(base.len()) == Some(&b'-'))
}

fn parse_sha256sum(text: &str) -> Option<String> {
    let tok = text.split_whitespace().next()?;
    if tok.len() == 64 && tok.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(tok.to_string())
    } else {
        None
    }
}

fn find_artifact(quartus: &Path, size: &str) -> Option<serde_json::Value> {
    let base = rbf_base(size);
    let mut dirs: Vec<(SystemTime, PathBuf)> = fs::read_dir(quartus)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| artifact_dir_matches(n, &base))
                .unwrap_or(false)
        })
        .filter_map(|e| {
            let m = e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            Some((m, e.path()))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, dir) in dirs {
        let rbf = dir.join(format!("{base}.rbf"));
        if !rbf.is_file() {
            continue;
        }
        let sha = fs::read_to_string(dir.join(format!("{base}.rbf.sha256sum")))
            .ok()
            .and_then(|t| parse_sha256sum(&t));
        return Some(serde_json::json!({
            "path": rbf.to_string_lossy(),
            "sha256": sha,
            "dir": dir.to_string_lossy(),
        }));
    }
    None
}

#[tauri::command]
pub fn legion_build_status() -> serde_json::Value {
    let mut guard = match BUILD.lock() {
        Ok(g) => g,
        Err(_) => return serde_json::json!({ "running": false, "reason": "build lock" }),
    };
    let Some(st) = guard.as_mut() else {
        return serde_json::json!({ "running": false });
    };
    let tail = log_tail(&st.log_path, 16 * 1024);
    match st.child.try_wait() {
        Ok(None) => serde_json::json!({
            "running": true,
            "tail": tail,
            "logPath": st.log_path.to_string_lossy(),
        }),
        Ok(Some(status)) => {
            let code = status.code().unwrap_or(-1);
            // Критерий успеха — сам артефакт: build_bladerf.sh без set -e
            // возвращает 0 и при упавшем Quartus, поэтому exit код — только
            // для информации, .rbf — единственное доказательство.
            let artifact = find_artifact(&st.quartus_dir, &st.size);
            let log_path = st.log_path.to_string_lossy().to_string();
            let elapsed = st.started.elapsed().map(|d| d.as_secs()).unwrap_or(0);
            *guard = None;
            serde_json::json!({
                "running": false,
                "exit": code,
                "tail": tail,
                "logPath": log_path,
                "elapsedSec": elapsed,
                "artifact": artifact,
            })
        }
        Err(e) => {
            *guard = None;
            serde_json::json!({ "running": false, "reason": format!("try_wait: {e}"), "tail": tail })
        }
    }
}

#[tauri::command]
pub fn legion_build_cancel() -> Result<String, String> {
    let mut guard = BUILD.lock().map_err(|_| "build lock")?;
    let Some(st) = guard.as_mut() else {
        return Err("сборка не идёт".into());
    };
    let pid = st.child.id();
    // setsid на старте: pid = pgid. TERM группе — build_bladerf.sh ловит
    // сигнал своим trap и добивает build_pids; через 3 с эскалация в KILL.
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{pid}")])
        .output();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match st.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = Command::new("kill")
                    .args(["-KILL", &format!("-{pid}")])
                    .output();
                let _ = st.child.kill();
                break;
            }
            Err(_) => break,
        }
    }
    let _ = st.child.wait();
    *guard = None;
    Ok(format!("сборка отменена (группа {pid})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_table() {
        assert!(board_args_ok("bladeRF", "40"));
        assert!(board_args_ok("bladeRF-micro", "A4"));
        assert!(board_args_ok("bladeRF-micro", "A9"));
        assert!(!board_args_ok("bladeRF-micro", "A2"));
        assert!(!board_args_ok("bladeRF-micro", "A5"));
        assert!(!board_args_ok("bladeRF", "115"));
        assert!(!board_args_ok("hackrf", "40"));
        assert!(!board_args_ok("bladeRF", "40; rm -rf /"));
    }

    #[test]
    fn rbf_names() {
        assert_eq!(rbf_base("40"), "legionx40");
        assert_eq!(rbf_base("A4"), "legionxA4");
        assert_eq!(rbf_base("A9"), "legionxA9");
    }

    #[test]
    fn artifact_dirs() {
        assert!(artifact_dir_matches("legionxA4", "legionxA4"));
        assert!(artifact_dir_matches("legionxA4-2026-08-28_21.30.00", "legionxA4"));
        assert!(!artifact_dir_matches("legionxA9", "legionxA4"));
        assert!(!artifact_dir_matches("legionxA40", "legionxA4"));
        assert!(!artifact_dir_matches("hostedxA4", "legionxA4"));
        assert!(!artifact_dir_matches("legionxA4.bak", "legionxA4"));
    }

    #[test]
    fn sha256_parse() {
        let h = "a".repeat(64);
        assert_eq!(parse_sha256sum(&format!("{h}  legionxA4.rbf\n")), Some(h.clone()));
        assert_eq!(parse_sha256sum(&format!("{h} *legionxA4.rbf")), Some(h));
        assert_eq!(parse_sha256sum("not-a-hash legionxA4.rbf"), None);
        assert_eq!(parse_sha256sum(""), None);
    }

    #[test]
    fn nios_shell_prefers_pin() {
        let v = |s: &str| PathBuf::from(s);
        // Пин 23.1 выигрывает у более новых/старых установок.
        let got = pick_nios_shell(vec![
            v("/home/u/intelFPGA_lite/20.1/nios2eds/nios2_command_shell.sh"),
            v("/home/u/intelFPGA_lite/23.1/nios2eds/nios2_command_shell.sh"),
            v("/home/u/intelFPGA_lite/24.1/nios2eds/nios2_command_shell.sh"),
        ]);
        assert_eq!(got, Some(v("/home/u/intelFPGA_lite/23.1/nios2eds/nios2_command_shell.sh")));
        // Без пина — последняя по сортировке (свежайшая установка).
        let got = pick_nios_shell(vec![
            v("/home/u/intelFPGA_lite/20.1/nios2eds/nios2_command_shell.sh"),
            v("/home/u/intelFPGA_lite/22.1/nios2eds/nios2_command_shell.sh"),
        ]);
        assert_eq!(got, Some(v("/home/u/intelFPGA_lite/22.1/nios2eds/nios2_command_shell.sh")));
        assert_eq!(pick_nios_shell(vec![]), None);
    }
}
