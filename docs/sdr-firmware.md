# LEGION — прошивки SDR и Ethernet

Два независимых режима (тракты не пересекаются):

| Режим | Железо | Прошивка | Кабель |
|---|---|---|---|
| ESP32 | ESP32 → ADF4351 → усилитель → 50 Ω | PlatformIO / OTA ESP32 | USB-UART к ESP32. Нет SDR. |
| SDR | антенна на RX, усилитель на RF out SDR | **официальный образ вендора** | Ethernet к ноутбуку. ESP32 не участвует. |

I/Q на ESP32 не идёт. ESP32 не шьёт FPGA SDR.

## Куда втыкается Ethernet

Факт Nuand: **bladeRF 2.0 micro xA4/xA9 — только USB 3.0, RJ45 на плате нет.**
Кабель Ethernet → мини-ПК-шлюз (USB3 к bladeRF). На шлюзе:

```
SoapySDRServer --bind
```

Клиент LEGION (desktop): `tools/sdr_worker.py` → SoapySDR Python
([wiki](https://github.com/pothosware/SoapySDR/wiki/PythonSupport)):
`Device(dict(driver="remote", remote="tcp://<шлюз>:55132"))`, порт 55132.

На шлюзе / ноутбуке:

```
sudo apt install python3-soapysdr soapysdr-tools python3-numpy
# bladeRF x40 / micro (антенна на RX, скан 40 MSPS):
sudo apt install soapysdr-module-bladerf
# другие платы: soapysdr-module-uhd / soapysdr-module-plutosdr / …
pip install -r tools/requirements.txt   # numpy: Hann + Welch-8 (DIO-sys)
SoapySDRServer --bind
```

| SDR | Куда RJ45 | Официальный образ | Чем шить |
|---|---|---|---|
| bladeRF xA4 | в **шлюз**, не в SDR | [hostedxA4-latest.rbf](https://www.nuand.com/fpga/hostedxA4-latest.rbf) + [bladeRF_fw_latest.img](https://www.nuand.com/fx3/bladeRF_fw_latest.img) | `bladeRF-cli -L` / `-f` |
| bladeRF xA9 | шлюз | [hostedxA9-latest.rbf](https://www.nuand.com/fpga/hostedxA9-latest.rbf) | то же |
| USRP N210 | **в сам N210** | `usrp_n210_r4_fpga.bin` / `usrp_n210_fw.bin` (`uhd_images_downloader`) | `uhd_image_loader --args="type=usrp2,addr=192.168.10.2"` |
| ADALM-Pluto | USB-gadget 192.168.2.1 или USB-ETH | [pluto.frm](https://github.com/analogdevicesinc/plutosdr-fw/releases/latest) | mass-storage + eject (wiki ADI) |
| LimeNET Micro | в сам LimeNET | LimeSuite | не ESP32 OTA |
| HackRF / Lime USB / B210 / RTL | шлюз SoapyRemote | свой вендорский путь | не путать с Nuand |

Исходники FPGA/FX3: [Nuand/bladeRF](https://github.com/Nuand/bladeRF) (`hdl/`, `fx3_firmware/`).
Пребилды — с nuand.com (Quartus/Cypress SDK закрытые).

## Что нам нужно от образа

Официальный **hosted** bitstream даёт RX+TX через libbladeRF/Soapy — скан полосы и перестройка TX LO. Поверх hosted — наша ревизия **legion** (`fpga/`, сборка из вендоренного дерева Nuand, обе платформы: x40 и micro xA4/xA9): автономный тракт в FPGA (детектор I²+Q², loopback RX→TX по гейту, плеер/NCO, watchdog-deadman) и NIOS-восстановление эфира на micro (AIR-регистры). Это и есть «detect за микросекунды» — внутри FPGA, не на хосте.

Не ставим чужие jam-FPGA и не шьём ESP32 этими файлами.

## Замысел образа (режим SDR)

Нужен **hosted** bitstream: RX (energy detect по allowlist) +
TX LO на RF out → усилитель; для конвейера «скан → FPGA-ретрансляция»
— ревизия legion поверх hosted (`bladeRF-cli -l/-L legion_xA4.rbf`,
сборка `fpga/vendor/bladerf/hdl/quartus/build_bladerf.sh -b bladeRF-micro -s A4 -r legion`).
FX3 `.img` без FPGA задачу не закрывает.
Имена вроде RF-Clown / BlueJammer / nRF24 отклоняются на хосте.

Запись в железо — вкладки **ПРОШИВКА SDR** и **ПРОШИВКА ESP32** (не одна кнопка).
SDR: только вендорский CLI (`bladeRF-cli -l/-L/-f`, `uhd_image_loader`,
`hackrf_spiflash`) после `validateFlashJob` + галочки. ESP32: только
`pio run -e <allowlist> --target upload` после `esptool chip_id` и совпадения
кристалла с env. Чужой домен / RF-Clown / native env — отказ.
Проверка имени ≠ запись. Без desktop LEGION команда не запускается.

## Это не RF-Clown и не BlueJammer

| | LEGION режим 1 | LEGION режим 2 | RF-Clown / BlueJammer |
|---|---|---|---|
| Радио | SDR (bladeRF/USRP/…) | ADF4351 | nRF24L01 (+ ESP32) |
| Кабель к ПК | Ethernet | USB-UART | USB только для прошивки |
| Задача | скан + тон на усилитель | коридор/частота | шум 2.4 ГГц (jam) |
| Образ | hosted Nuand/ADI/Ettus | PlatformIO LEGION | чужой `.bin` |
