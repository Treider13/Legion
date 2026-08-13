// ============================================================================
// LEGION — карта пинов ADF4351 для каждой поддерживаемой платы ESP32
// Сигналы: CLK, DATA, LE (SPI bit-bang), LD (Lock Detect, вход), CE (Chip Enable)
// Правила выбора пинов: избегаем strapping-пины (BOOT=GPIO0/9), USB (19/20 на
// S2/S3/C3/C6, 26/27 на H2), flash-пины. Все линии 3.3 В — напрямую к модулю.
// ============================================================================
#pragma once

#if defined(LEGION_BOARD_CLASSIC)
// ESP32 DevKit (VSPI-совместимые пины, классика)
#define PIN_ADF_CLK 18
#define PIN_ADF_DATA 23
#define PIN_ADF_LE 5
#define PIN_ADF_LD 19
#define PIN_ADF_CE 22
// PE43702 (фаза 8)
#define PIN_ATT_CLK 25
#define PIN_ATT_DATA 26
#define PIN_ATT_LE 27

#elif defined(LEGION_BOARD_S3)
// ESP32-S3-DevKitC-1 (избегаем USB 19/20, strapping 0/3/45/46)
#define PIN_ADF_CLK 12
#define PIN_ADF_DATA 11
#define PIN_ADF_LE 10
#define PIN_ADF_LD 13
#define PIN_ADF_CE 14
#define PIN_ATT_CLK 15
#define PIN_ATT_DATA 16
#define PIN_ATT_LE 17

#elif defined(LEGION_BOARD_S2)
// ESP32-S2-Saola-1 (избегаем USB 19/20)
#define PIN_ADF_CLK 12
#define PIN_ADF_DATA 11
#define PIN_ADF_LE 10
#define PIN_ADF_LD 13
#define PIN_ADF_CE 14
#define PIN_ATT_CLK 15
#define PIN_ATT_DATA 16
#define PIN_ATT_LE 17

#elif defined(LEGION_BOARD_C3) || defined(LEGION_BOARD_C6) || defined(LEGION_BOARD_H2)
// ESP32-C3/C6/H2 (избегаем BOOT=9, USB 18/19 на C3/C6, USB 26/27 на H2)
#define PIN_ADF_CLK 4
#define PIN_ADF_DATA 6
#define PIN_ADF_LE 5
#define PIN_ADF_LD 7
#define PIN_ADF_CE 10
// PE43702: пины 2/3/8 существуют на C3, C6 и H2 (проверено по pinout'ам)
#define PIN_ATT_CLK 2
#define PIN_ATT_DATA 3
#define PIN_ATT_LE 8

#else
#error "LEGION: неизвестная плата — задайте LEGION_BOARD_* в platformio.ini"
#endif
