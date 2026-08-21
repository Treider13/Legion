// ============================================================================
// LEGION — serial_sync: мьютекс на вывод в UART.
// Гонка: telem_task (телеметрия 10 Гц) и cmd_server (ответы, loop-задача)
// писали в Serial одновременно → строки перемешивались посреди кадра.
// Найдено при ревизии гонок (аудит по п.1). Теперь весь вывод под мьютексом.
// ============================================================================
#pragma once

namespace legion {

void serial_sync_init();  // вызвать в setup() ДО старта задач
void serial_lock();       // блокирующий захват (FreeRTOS mutex)
void serial_unlock();

// Мьютекс исполнения команд: UART/WS команды исполняются в loop-задаче,
// BLE (NimBLE onWrite) — в host-задаче стека. AppState/policy своих мьютексов
// не имеют (uint64 freq_hz на 32-битном MCU — torn access) → сериализуем.
// Порядок блокировок везде cmd → serial → synth/leveling, обратного нет.
void cmd_lock();
void cmd_unlock();

}  // namespace legion
