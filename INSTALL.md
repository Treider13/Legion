# LEGION — установка (Ubuntu 22.04 / 24.04)

**Инструкция актуальна только для Linux** (проверено на Ubuntu 22.04/24.04).
Windows/macOS не поддерживаются: шлюз FPGA, приёмка E1–E6 и сборка ревизии
legion привязаны к Linux-инструментам (pyusb/systemd/Quartus для Linux).

Пошаговый сценарий «чистая Ubuntu → рабочий стенд с bladeRF 2.0 micro xA4».
Тракт ESP32 (режим 2) — в конце, он независим.

Быстрая проверка окружения после установки:

```bash
./setup.sh            # проверка всех зависимостей с понятными подсказками
./setup.sh --install  # попытаться доустановить недостающее (apt/pip/npm)
```

## 1. Системные пакеты

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip nodejs npm \
  bladerf libbladerf-dev bladerf-firmware-fx3 bladerf-fpga-hostedxA4 \
  python3-soapysdr soapysdr-tools soapysdr-module-bladerf python3-numpy \
  python3-usb
```

- **bladeRF-cli / libbladeRF** — прошивка FPGA/FX3 и драйвер платы.
  Если пакета нет в вашей сборке Ubuntu — соберите из
  [Nuand/bladeRF](https://github.com/Nuand/bladeRF) (host).
- **SoapySDR + модуль bladeRF** — сканер и стримы. SoapySDR **не ставится
  через pip**: нужен системный биндинг (`python3-soapysdr`). venv — только
  с `--system-site-packages`. Если `import SoapySDR` падает при установленном
  пакете (deadsnakes/другой python) — `LEGION_PYTHON=/usr/bin/python3`.
- **python3-usb** — шлюз FPGA под systemd зовёт `/usr/bin/python3`, не venv.
  Без системного пакета юнит падает на `import usb`, даже если pyusb стоит в `.venv`.
- **Node.js** — нужен ≥ 20 (лучше 22 LTS). Если в репозитории Ubuntu старая
  версия: [NodeSource](https://github.com/nodesource/distributions) или nvm.

Проверка:

```bash
bladeRF-cli --version        # драйвер платы
SoapySDRUtil --find          # видит модуль bladerf
python3 -c "import SoapySDR" # python-биндинг
node --version               # ≥ 20
```

### udev-правила (USB без root)

Пакет `bladerf` из Ubuntu обычно ставит правила сам. Проверка:

```bash
dpkg -L bladerf libbladerf2 2>/dev/null | grep udev   # готовые правила пакета
ls /etc/udev/rules.d/ /lib/udev/rules.d/ 2>/dev/null | grep -i nuand
```

Если правил нет (плата видна только под root — `bladeRF-cli -p` молчит у
обычного пользователя), возьмите их из дерева Nuand:
[host/misc/udev](https://github.com/Nuand/bladeRF/tree/master/host/misc/udev)
— там шаблоны `88-nuand-bladerf1.rules.in` / `88-nuand-bladerf2.rules.in`
(подстановка `@BLADERF_GROUP@` → группа `plugdev` — дефолт в их CMake,
режим `660`; готовые варианты есть и в пакете `libbladerf2`/`bladerf`
большинства сборок).
Копировать в `/etc/udev/rules.d/` с расширением `.rules`, затем
`sudo udevadm control --reload && sudo udevadm trigger`. Шлюз и приёмка
работают от обычного пользователя; root не нужен.

## 2. Python-зависимости проекта (venv)

На современных Ubuntu системный pip блокирован (PEP 668) — ставим в venv:

```bash
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r tools/requirements.txt -r fpga/requirements.txt
```

`numpy` обязателен для сканера эфира; `pyusb` — для агента шлюза FPGA.

## 3. Приложение LEGION Control

Браузерная сборка (достаточно Node.js, без Rust):

```bash
cd app
npm ci
npm run dev
```

Desktop (Tauri) — дополнительно нужны Rust и системные библиотеки WebKit
(те же, что в CI):

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustup, stable
source "$HOME/.cargo/env"
cd app
npm ci
npm run tauri dev
```

## 4. Шлюз FPGA (мини-ПК с USB3 к bladeRF)

На шлюзе (может быть тот же ноутбук, если плата локальная). pyusb ставим
**системным пакетом** — pip на современной Ubuntu блокирован PEP 668 (§2),
а systemd-юнит работает с системным `/usr/bin/python3`:

```bash
sudo apt install -y python3-usb      # pyusb
export LEGION_FPGA_TOKEN=<секрет>    # рекомендуется
python3 fpga/host/legion_gateway.py  # порт 5531
```

(Альтернатива — venv как в §2: `.venv/bin/python fpga/host/legion_gateway.py`.)

**Один владелец USB.** У bladeRF один USB-интерфейс, захватываемый
эксклюзивно: `legion_gateway.py` и `SoapySDRServer` одновременно на одной
плате **не работают** (факт из дескриптора FX3, подробности —
`fpga/README.md`, «Эксплуатационные факты»). Порядок смены владельца —
только через команды шлюза `usb release`/`usb acquire`.

Прошивка ревизии legion **не требует останавливать агент**, если идёте
через вкладку **КАСТОМ FPGA** (desktop Tauri) или `{"op":"flash",...}`:
шлюз сам отпускает USB, гоняет `bladeRF-cli -l` (RAM) или `-L` (autoload),
потом занимает USB обратно и читает target 0x80. SoapySDRServer на той же
плате перед этим остановить. Ручной CLI с этой машины — тогда да: стоп
агента → `bladeRF-cli -l/-L` → старт агента.

Автозапуск — systemd-юнит `fpga/systemd/legion-gateway.service`:

```bash
sudo install -d /opt/legion
sudo install -m644 fpga/host/legion_gateway.py fpga/host/legion_fpga.py /opt/legion/
sudo install -m644 fpga/systemd/legion-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now legion-gateway
systemctl status legion-gateway   # active (running), порт 5531
```

Токен (`LEGION_FPGA_TOKEN`) и автозагрузка образа (`LEGION_FPGA_RBF`)
задаются раскомментированием строк `Environment=` в юните. Если FPGA пустая
после подачи питания (xA4 питается от USB) — без `LEGION_FPGA_RBF` агент
честно откажет, с ним загрузит образ сам.

## 5. Образ FPGA ревизии legion

Пребилда нет — сборка из вендоренного дерева репозитория. Внешний инструмент
ровно один: **Quartus Prime Lite 23.1.1** (бесплатный, регистрация Intel):
страница загрузки — [intel.com → Quartus Prime Lite](https://www.intel.com/content/www/us/en/products/details/fpga/development-tools/quartus-prime.html)
— нужны пакеты Cyclone V (micro xA4/xA9) и/или Cyclone IV E (bladeRF 1 x40),
NIOS II EDS входит в установку.

```bash
fpga/check_toolchain.sh   # проверка тулчейна до сборки
# Сборка — из nios2_command_shell (NIOS II EDS входит в Quartus Lite):
source ~/intelFPGA_lite/23.1std/nios2eds/nios2_command_shell.sh
cd fpga/vendor/bladerf/hdl/quartus
./build_bladerf.sh -b bladeRF-micro -s A4 -r legion   # → legionxA4.rbf (micro xA4)
./build_bladerf.sh -b bladeRF-micro -s A9 -r legion   # → legionxA9.rbf (micro xA9)
./build_bladerf.sh -b bladeRF -s 40 -r legion         # → legionx40.rbf (bladeRF 1 x40)
```

Запись в плату — из **desktop** LEGION (Tauri: `npm run tauri dev` / собранное
приложение), вкладка **КАСТОМ FPGA**: СОБРАТЬ (Quartus на этом ПК) → ПРОШИТЬ
локальный USB или путь к уже скопированному `.rbf` на шлюзе. Браузерный
`npm run dev` сборку и `bladeRF-cli` не запускает (`hostSdrAvailable` = Tauri).
Вручную: `bladeRF-cli -l legionxA4.rbf` (RAM, откат — power cycle),
`bladeRF-cli -L legionxA4.rbf` (flash autoload). Официальный `hostedxA4.rbf` —
это hosted, не legion: ARM откажет (`legion:false`).

## 6. Приёмка на железе (обязательна)

**Без зелёного прогона E1–E6 на целевой плате система стабильной не
считается.** Кабель TX→RX через аттенюатор 20–30 дБ, на шлюзе запущен
`legion_gateway.py`:

```bash
fpga/test/run_acceptance.sh --gw <IP шлюза> --board micro --ssh user@<IP шлюза>
# или с автокоммитом зелёного отчёта (коммитит только ALL PASS):
fpga/test/run_acceptance_and_commit.sh --gw <IP шлюза> --board micro --ssh user@<IP шлюза>
```

Лог и JSON-отчёт — `fpga/test/results/`. Этапы и критерии — `fpga/README.md`.

## 7. Тракт ESP32 (режим 2, опционально)

```bash
source .venv/bin/activate
pip install "platformio>=6.1"
cd firmware
pio run -e esp32-s3 --target upload    # env под вашу плату (см. platformio.ini)
```

Распиновка — `docs/wiring.md`, оборудование — `docs/hardware.md`.

## Что где задокументировано

| Тема | Файл |
|---|---|
| Архитектура | `docs/architecture.md` |
| Зависимости (версии, источники) | `docs/dependencies.md` |
| Протокол ESP32 | `docs/protocol.md` |
| Прошивки SDR / Ethernet | `docs/sdr-firmware.md` |
| FPGA legion: сборка, эксплуатация, приёмка | `fpga/README.md` |
| Железо и стенд | `docs/hardware.md` |
| Правовая рамка | `docs/compliance.md` |
