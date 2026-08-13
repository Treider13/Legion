# LEGION — Реестр заимствований (идея → источник → где у нас)

Всё, что LEGION взял из чужих проектов/форумов/статей, — с атрибуцией.
Проверено в ходе трёх раундов исследования (GitHub, EEVblog, EngineerZone,
BATC, Hackaday, IEEE).

## Код / эталоны

| Что взято | Источник | Лицензия | Где у нас |
|---|---|---|---|
| Эталон расчёта регистров (тест-оракул) | [jhol/pyadf435x](https://github.com/jhol/pyadf435x) | GPL-3.0 | `third_party/pyadf435x/core.py`; тесты `firmware/test/test_freq_planner/` |
| Математика INT/FRAC/MOD (по даташиту) | [dfannin/adf4351](https://github.com/dfannin/adf4351) | MIT-подобная | `firmware/src/freq_planner.cpp` (наша реализация на uint64, без BigNumber) |
| Bit-bang WriteRegister (MSB first, LE pulse) | [Ryushane/ADF4351-ESP32](https://github.com/Ryushane/ADF4351-ESP32) | GPL-3.0 | `firmware/src/adf4351.cpp` (наш — на gpio_ll, без delay(1)) |
| ASCII-протокол однобуквенных команд | [kb3gtn/STM32_ADF4351](https://github.com/kb3gtn/STM32_ADF4351) | GPL-3.0 | `docs/protocol.md` (наш протокол — словесный, расширенный) |
| GLIDE / FM-паттерны (SIN/TRI/RAND), рампа | [Electro-resonance/ADF4351-USB-Serial](https://github.com/Electro-resonance/ADF4351-USB-Serial) | MIT | `firmware/src/sweep_engine.cpp` (режимы GLIDE/FM, фаза 6) |
| Автономность: конфиг в EEPROM/NVS, рестарт режима | [joseluu/ADF_4351_BT_Smartphone](https://github.com/joseluu/ADF_4351_BT_Smartphone) + [Hackaday log](https://hackaday.io/project/162097) | — | `firmware/src/storage.cpp` (NVS), идея BLE-управления (фаза 7) |
| Sweep-реализация 35М–4.4Г шагом 1 МГц | [aksrivastava/Signal-Jammer](https://github.com/aksrivastava/Signal-Jammer) | — | `firmware/src/sweep_engine.cpp` (наш — на тиках FreeRTOS, не delay) |
| Web-сервер + WiFi + ADF4351 на ESP32 | [f4bjh/Rf-Test-BJH](https://github.com/f4bjh/Rf-Test-BJH) | — | `firmware/src/net_server.cpp` (доказательство жизнеспособности) |
| Sweep-примеры (BasicSweep/SweepMixer/SweepFilter) | [alhosani-abdulla/adf4351-controller](https://github.com/alhosani-abdulla/adf4351-controller) | — | структура режимов коридора |
| Python CLI-референс | [Wei1234c/Signal_Generators](http://wei1234c.blogspot.com/2020/06/adf4351-frequency-synthesizer-en.html) | GPL-3.0 | `tools/legion_cli.py` + идея `REGS DIFF` |
| Desktop GUI референс (USB HID + Qt) | [circuitvalley/ADF4351_USB_RF_GEN](https://github.com/circuitvalley/ADF4351_USB_RF_GEN) | CC BY-NC-ND | концепт desktop-приложения (наш — Tauri, свой код) |
| Аттенюатор PE43702 в связке с ADF4351 | [dd1us.de статья](https://www.dd1us.de/Downloads/ADF4351%20PLL%20module%20with%20OLED%201v3.pdf) | — | `firmware/src/attenuator.cpp` (фаза 8) |

## Форумы / практика (грабли и рецепты)

| Факт | Источник | Где учтено |
|---|---|---|
| Порядок записи R5→R0, R0 последним | Даташит ADI + EngineerZone | `adf4351.cpp::writePlan` |
| Диагностика SPI без приборов (powerdown/polarity/MUXOUT) | EngineerZone (офиц. поддержка ADI) | `selftest.cpp` |
| Перепутанные пины DAT/CLK/LE на AliExpress-модулях | FB EME group (VK4AMG) | `docs/module-quirks.md` M1 + SELFTEST |
| Просадка питания AMS1117 | FB EME group | `docs/module-quirks.md` M2, `docs/wiring.md` |
| 100 МГц osc → «comb»-мусор | BATC forum | `docs/module-quirks.md` M3 |
| Замена кварца на TCXO (R5/R8) | BATC (G4HIZ), Open Tech Lab | `docs/module-quirks.md` M4 |
| Ошибка ConvertFreq() на 2.175 ГГц (OE6OCG) | KD0CQ blog | тест `test_vector_2175` |
| MTLD для чистого свипа | Даташит + EngineerZone | `sweep_engine.cpp` (MTLD в коридоре) |
| Баг sweep >10 мс (блокирующие delay) | Hackaday (joseluu) | наша архитектура на тиках FreeRTOS |

## Научные работы

| Работа | Что дала |
|---|---|
| IEEE Access 2019, Weyer et al. «Design Considerations for Integrated Radar Chirp Synthesizers» | CHIRP-режим: полоса петли vs stepping rate; мелкий FRAC-шаг (фаза 6) |
| IEEE RTEICT 2017 «Design of frequency synthesizer…» (ADF4351+PIC32) | верификация подхода МК+ADF4351 |
| ICIE 2017 (STM32F103 + ADF4351 + OLED) | референс-архитектура |

## Дизайн (фаза 5)

| Источник | Что взято |
|---|---|
| Awwwards SOTD 2026 аналитика (digitalstrategyforce.com, svilenkovic.com) | формула: Three.js + GSAP + Lenis; сдержанность; device-tier; DPR≤2; reduced-motion |
| «Neo-Prime» язык (Anduril/Palantir/Helsing; LinkedIn-исследование Michael N.; кейс Helsing — gustavoh.de) | тёмный HUD, моноширинная типографика, high-fidelity схемы |
| Codrops 04/2026 (scroll-driven 3D) | KTX2/Draco, GPU instancing, shared scroll store |
| tsogjavklann/awwwards-3d (Claude Code skill) | стек-референс Three.js r170 + GSAP + Lenis |
