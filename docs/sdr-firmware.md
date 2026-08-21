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
# + драйвер: SoapyBladeRF / SoapyUHD / SoapyPlutoSDR
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

Официальный **hosted** bitstream даёт RX+TX через libbladeRF/Soapy — скан полосы и перестройка TX LO. Свой HDL «detect за микросекунды» в репозиторий не кладём: xA4 49 kLE тесен, это не hosted-образ.

Не ставим чужие jam-FPGA и не шьём ESP32 этими файлами.

## Замысел образа (режим SDR)

Нужен официальный **hosted** bitstream: RX (energy detect по allowlist) +
TX LO на RF out → усилитель. FX3 `.img` без FPGA задачу не закрывает.
Имена вроде RF-Clown / BlueJammer / nRF24 отклоняются на хосте.

Запись в железо — только вендорский CLI (`bladeRF-cli -l/-L/-f`,
`uhd_image_loader`, `hackrf_spiflash`) и только если выбран реальный файл
(размер > 0). Проверка имени ≠ запись. Без CLI LEGION пишет «не записано».

## Это не RF-Clown и не BlueJammer

| | LEGION режим 1 | LEGION режим 2 | RF-Clown / BlueJammer |
|---|---|---|---|
| Радио | SDR (bladeRF/USRP/…) | ADF4351 | nRF24L01 (+ ESP32) |
| Кабель к ПК | Ethernet | USB-UART | USB только для прошивки |
| Задача | скан + тон на усилитель | коридор/частота | шум 2.4 ГГц (jam) |
| Образ | hosted Nuand/ADI/Ettus | PlatformIO LEGION | чужой `.bin` |
