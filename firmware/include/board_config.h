// ============================================================================
// LEGION — feature-флаги по платам (см. docs/architecture.md §2.2, факт T5)
// ============================================================================
#pragma once

// WiFi есть у всех, кроме H2
#if defined(LEGION_BOARD_H2)
#define LEGION_HAS_WIFI 0
#else
#define LEGION_HAS_WIFI 1
#endif

// Bluetooth: нет на S2; Classic — только на classic; BLE — на всех остальных
#if defined(LEGION_BOARD_S2)
#define LEGION_HAS_BT 0
#define LEGION_HAS_BT_CLASSIC 0
#else
#define LEGION_HAS_BT 1
#if defined(LEGION_BOARD_CLASSIC)
#define LEGION_HAS_BT_CLASSIC 1
#else
#define LEGION_HAS_BT_CLASSIC 0
#endif
#endif

// Native USB CDC (без внешнего USB-UART моста): S2/S3/C3/C6/H2
#if defined(LEGION_BOARD_CLASSIC)
#define LEGION_HAS_NATIVE_USB 0
#else
#define LEGION_HAS_NATIVE_USB 1
#endif

// Быстрый bit-bang через SFR GPIO.out_w1ts/out_w1tc — есть на всём семействе
// (факт E1: ~10 МГц против ~1–2 мкс на digitalWrite)
#define LEGION_HAS_FAST_GPIO 1
