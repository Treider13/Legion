# LEGION — Протокол обмена

ASCII по USB-UART (115200 8N1) и JSON по WebSocket — одна семантика.
Команды завершаются `\n`. Ответы: `OK ...` / `ERR <code> <message>` / JSON для запросов состояния.

## Команды

| Команда | Формат | Ответ | Описание |
|---|---|---|---|
| Идентификация | `HELLO` | `OK LEGION <ver> <board>` | рукопожатие |
| Частота | `SET FREQ <MHz>` (напр. `SET FREQ 2475.000`) | `OK FREQ=2475.000000 LOCK=1` | 35–4400 МГц |
| Мощность | `SET POWER <-4\|-1\|+2\|+5>` | `OK` | дБм, 4 ступени (F9) |
| Вкл/выкл выход | `RF ON` / `RF OFF` | `OK` | через CE + R4 |
| Свип | `SWEEP START <f1> <f2> STEP <kHz> DWELL <ms>` | `OK SWEEP RUNNING` | линейный коридор |
| Хоппинг | `HOP START <f1> <f2> RATE <ms> SEED <n>` | `OK HOP RUNNING` | псевдослучайный (xorshift32) |
| Чирp (фаза 6) | `CHIRP START <f1> <f2> STEP <Hz> DWELL <ms>` | `OK CHIRP RUNNING` | FMCW-рампа, **шаг в Гц** |
| Глайд (фаза 6) | `GLIDE <targetMHz> <durationMs>` | `OK GLIDE RUNNING a -> b` | плавный переход, авто-стоп |
| ЧМ (фаза 6) | `FM START <SIN\|TRI\|RAND> CENTER <MHz> DEPTH <kHz> RATE <ms>` | `OK FM RUNNING SIN` | ЧМ вокруг центра |
| Стоп | `STOP` | `OK IDLE` | останов любого режима |
| WiFi (фаза 4) | `WIFI AP` / `WIFI STA <ssid> <pass>` / `WIFI STATUS?` | `OK ...` / JSON | управление сетью |
| Статус | `STATUS?` | `{"freq":...,"mode":...,"lock":...}` | JSON |
| Регистры | `REGS?` | JSON R0–R5 | диагностика |
| Регистры diff | `REGS DIFF <r0> <r1> ... <r5>` | JSON расхождений | идея Wei1234c |
| Самотест | `SELFTEST` | JSON по шагам F13 | диагностика SPI |
| Калибровка | `CAL REF <ppm>` | `OK` | учёт в freq_planner |
| Аттенюатор (фаза 8) | `SET ATT <dB>` | `OK` | 0–31.75 шаг 0.25; отключает авто-выравнивание |
| Калибровка уровня (фаза 10) | `CAL LEVEL <freqMHz> <dBm>` / `CAL LEVEL CLEAR` | `OK CAL LEVEL ... n=<k>` | точка «частота → измеренный выход» |
| Выравнивание уровня (фаза 10) | `SET LEVEL <dBm>` / `SET LEVEL OFF` | `OK LEVEL=<dBm> ATT=<dB>` | плоский уровень через PE43702 по калибровке |
| Статус уровня (фаза 10) | `LEVEL?` | JSON `{enabled,target,points}` | таблица калибровки |
| Allowlist (фаза 11) | `ALLOW ADD <f1> <f2>` / `ALLOW CLEAR` / `ALLOW?` | `OK ALLOW n=` / JSON | полосы, заранее разрешённые законом |
| Нагрузка (фаза 11) | `LOAD OK` / `LOAD FAULT` / `LOAD?` | `OK LOAD …` / JSON | интерлок эквивалента 50 Ом |
| Усилитель (фаза 11) | `PA SET I <mA>` / `PA ON` / `PA OFF` / `PA?` | `OK PA …` / JSON | ток 0–1500 мА; ON только при LOAD OK и I>0 |
| Наведение (фаза 11) | `CUE <MHz>` | `OK CUE FREQ=… LOCK=` | SET FREQ только если частота в allowlist; **RF не включает** |

Пустой allowlist **не** меняет SET FREQ / RF ON / SWEEP (совместимость фаз 1–10).
Непустой allowlist: RF ON и коридор TX обязаны попадать в полосу.
`CUE` всегда требует непустой allowlist и попадание.
`LOAD FAULT` гасит RF и PA. `ERR LOAD` / `ERR ALLOW` — новые коды.

Кнопка **ПЕРЕДАТЬ** в UI (вкладка СКАН RX) — разовое согласие оператора:
хост один раз делает `ALLOW` + `LOAD OK` + `PA SET I` + `PA ON`. Дальше на
каждый улов в allowlist: TX LO внутри SDR (тот же процесс, скан не рвётся на
full-duplex) и `CUE` на ADF4351; `RF ON` — один раз после первого улова.
`CUE` **не** включает RF. Повторные `PA SET I`/`PA ON` на каждый улов не
нужны (это была лишняя задержка UART). Улов в нагрузке красится красным.

`CUE` на прошивке — live-путь: `synth_apply_fast` (delta SPI), без записи
частоты в NVS и без ожидания LOCK. Ручной `SET FREQ` по-прежнему ждёт LOCK
и сохраняет NVS.

## Телеметрия (WebSocket push, 10 Гц в режиме коридора)

```json
{"t": 12345, "freq": 2442.500, "lock": 1, "mode": "SWEEP"}
```

События движка (одноразовые, напр. завершение GLIDE):

```json
{"t": 0, "event": "GLIDE DONE"}
```

## Коды ошибок

| Код | Значение |
|---|---|
| `ERR RANGE` | частота вне 35–4400 МГц |
| `ERR SYNTAX` | парсер не понял команду |
| `ERR LOCK` | нет захвата петли после таймаута |
| `ERR STATE` | команда недопустима в текущем режиме |
| `ERR DWELL` | dwell < минимально допустимого (band select + settling) |
| `ERR LOAD` | нет подтверждённой нагрузки 50 Ом (RF ON / PA ON) |
| `ERR ALLOW` | частота или коридор вне allowlist; либо CUE без попадания |
