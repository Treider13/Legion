//! LEGION — прошивка ESP32 только своим PlatformIO env.
//! Аргументы CLI с фронта не принимаем. SDR-бинари здесь не запускаются.
//! Перед upload хост сам делает esptool chip_id и сверяет с env.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const ESP32_ENVS: &[&str] = &[
    "esp32dev",
    "esp32-s3",
    "esp32-s2",
    "esp32-c3",
    "esp32-c6",
    "esp32-h2",
];

const CHIP_ID_TIMEOUT: Duration = Duration::from_secs(25);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);

fn env_ok(env: &str) -> bool {
    ESP32_ENVS.contains(&env)
}

fn port_ok(port: &str) -> bool {
    let p = port.trim();
    if p.is_empty() || p.contains("..") || p.chars().any(char::is_whitespace) {
        return false;
    }
    let up = p.to_ascii_uppercase();
    if up.starts_with("COM") && (4..=6).contains(&up.len()) && up[3..].bytes().all(|b| b.is_ascii_digit())
    {
        return true;
    }
    if let Some(rest) = p.strip_prefix("/dev/ttyUSB") {
        return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(rest) = p.strip_prefix("/dev/ttyACM") {
        return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
    }
    for prefix in [
        "/dev/cu.usbserial",
        "/dev/cu.usbmodem",
        "/dev/tty.usbserial",
        "/dev/tty.usbmodem",
    ] {
        if let Some(rest) = p.strip_prefix(prefix) {
            return rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        }
    }
    if let Some(rest) = p.strip_prefix("/dev/serial/by-id/") {
        return !rest.is_empty()
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    }
    false
}

fn parse_chip(text: &str) -> Option<String> {
    const NAMES: &[&str] = &[
        "ESP32-S3",
        "ESP32-S2",
        "ESP32-C6",
        "ESP32-C3",
        "ESP32-H2",
        "ESP32-P4",
        "ESP32",
    ];
    let upper = text.to_uppercase();
    for name in NAMES {
        let a = format!("CHIP IS {name}");
        let b = format!("DETECTING CHIP TYPE... {name}");
        if upper.contains(&a) || upper.contains(&b) {
            return Some((*name).to_string());
        }
    }
    None
}

fn env_matches(env: &str, chip: &str) -> bool {
    match env {
        "esp32-s3" => chip == "ESP32-S3",
        "esp32-s2" => chip == "ESP32-S2",
        "esp32-c3" => chip == "ESP32-C3",
        "esp32-c6" => chip == "ESP32-C6",
        "esp32-h2" => chip == "ESP32-H2",
        "esp32dev" => chip == "ESP32",
        _ => false,
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

fn python_bin() -> &'static str {
    if Command::new("python3").arg("-c").arg("1").output().is_ok() {
        "python3"
    } else {
        "python"
    }
}

fn pio_bin() -> Result<PathBuf, String> {
    which("pio")
        .or_else(|| which("platformio"))
        .ok_or_else(|| "pio/platformio не найден в PATH — прошивка ESP32 не запущена".into())
}

struct Esptool {
    bin: PathBuf,
    prefix: Vec<String>,
}

fn esptool() -> Result<Esptool, String> {
    if let Some(p) = which("esptool.py") {
        return Ok(Esptool {
            bin: p,
            prefix: vec![],
        });
    }
    if let Some(p) = which("esptool") {
        return Ok(Esptool {
            bin: p,
            prefix: vec![],
        });
    }
    Ok(Esptool {
        bin: PathBuf::from(python_bin()),
        prefix: vec!["-m".into(), "esptool".into()],
    })
}

fn firmware_dir(env: &str) -> Result<PathBuf, String> {
    if env == "native" || env == "native_fuzz" {
        return Err("env native на железо не шьём".into());
    }
    let candidates = [
        std::env::var("LEGION_FIRMWARE_DIR").ok().map(PathBuf::from),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../firmware")),
    ];
    for dir in candidates.into_iter().flatten() {
        let ini_path = dir.join("platformio.ini");
        if !ini_path.is_file() {
            continue;
        }
        let ini = fs::read_to_string(&ini_path).map_err(|e| format!("чтение platformio.ini: {e}"))?;
        if !ini.contains("LEGION") {
            return Err("это не прошивка LEGION (нет метки в platformio.ini)".into());
        }
        if !ini.contains(&format!("[env:{env}]")) {
            return Err(format!("в platformio.ini нет [env:{env}]"));
        }
        return Ok(dir);
    }
    Err("firmware/ не найден (LEGION_FIRMWARE_DIR или репозиторий LEGION)".into())
}

fn drain(pipe: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let mut r = pipe;
        let _ = r.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

fn run_limited(mut cmd: Command, timeout: Duration, label: &str) -> Result<String, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("запуск {label}: {e}"))?;
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
                thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("{label}: {e}")),
        }
    };
    let stdout = out_rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();
    let stderr = err_rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();
    let text = format!("{stdout}{stderr}");
    if status.success() {
        Ok(text)
    } else {
        Err(format!(
            "{label} exit {}: {text}",
            status.code().unwrap_or(-1)
        ))
    }
}

fn run_chip_id(port: &str) -> Result<String, String> {
    let tool = esptool()?;
    let mut cmd = Command::new(&tool.bin);
    cmd.args(&tool.prefix);
    cmd.args(["--port", port, "chip_id"]);
    // Только chip_id. write_flash / erase_flash сюда не попадают.
    run_limited(cmd, CHIP_ID_TIMEOUT, "esptool chip_id")
}

#[tauri::command]
pub fn esp32_chip_id(port: String) -> Result<String, String> {
    if !port_ok(&port) {
        return Err("порт не похож на USB-UART (/dev/ttyUSB* / ttyACM* / COM*)".into());
    }
    run_chip_id(port.trim())
}

#[tauri::command]
pub fn esp32_flash(env: String, port: String) -> Result<String, String> {
    if !env_ok(&env) {
        return Err(format!("env «{env}» не из allowlist LEGION — не шьём"));
    }
    if !port_ok(&port) {
        return Err("порт не похож на USB-UART — отказ".into());
    }
    let dir = firmware_dir(&env)?;
    let chip_text = run_chip_id(port.trim())?;
    let chip = parse_chip(&chip_text).ok_or_else(|| {
        format!("не разобрали чип по chip_id — upload не запущен. {chip_text}")
    })?;
    if !env_matches(&env, &chip) {
        return Err(format!("чип {chip} ≠ env {env} — отказ, иначе кирпич"));
    }
    let pio = pio_bin()?;
    let mut cmd = Command::new(&pio);
    cmd.current_dir(&dir);
    cmd.args([
        "run",
        "-e",
        env.as_str(),
        "--target",
        "upload",
        "--upload-port",
        port.trim(),
    ]);
    let out = run_limited(cmd, UPLOAD_TIMEOUT, "pio upload")?;
    Ok(format!("записано env {env} на {chip}: {out}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_rejects_injection() {
        assert!(!port_ok("/dev/ttyUSB0;rm"));
        assert!(!port_ok("/dev/ttyUSB0/../sda"));
        assert!(!port_ok("/dev/ttyUSB0 --write_flash"));
        assert!(!port_ok("pio"));
        assert!(port_ok("/dev/ttyUSB0"));
        assert!(port_ok("/dev/ttyACM1"));
        assert!(port_ok("COM3"));
        assert!(!port_ok("COM"));
        assert!(port_ok("/dev/cu.usbserial-0001"));
    }

    #[test]
    fn env_allowlist() {
        assert!(env_ok("esp32-s3"));
        assert!(env_ok("esp32dev"));
        assert!(!env_ok("native"));
        assert!(!env_ok("native_fuzz"));
        assert!(!env_ok("esp32-s3 --target erase"));
    }

    #[test]
    fn chip_parse_and_match() {
        assert_eq!(
            parse_chip("Chip is ESP32-S3 (QFN56) (revision v0.2)"),
            Some("ESP32-S3".into())
        );
        assert_eq!(
            parse_chip("Detecting chip type... ESP32-C3"),
            Some("ESP32-C3".into())
        );
        assert_eq!(
            parse_chip("Chip is ESP32 (revision 3)"),
            Some("ESP32".into())
        );
        assert!(env_matches("esp32-s3", "ESP32-S3"));
        assert!(!env_matches("esp32-s3", "ESP32-C3"));
        assert!(env_matches("esp32dev", "ESP32"));
        assert!(!env_matches("esp32dev", "ESP32-S3"));
        assert!(!env_matches("native", "ESP32"));
    }
}
