# Умная атака — итоговый план (к реализации)

Одна спецификация. v3 и поправка по слоту влиты сюда. Четыре недомолвки (накопление TILE, sentinel `CH_TARGET`, first-valid после hop, приоритет карточки на 5.8) закрыты формулами, не словами.

База: `origin/main` после #85 / #86. Код не пишется вразрез с таблицами ниже.

Замысел: **после Старта FPGA стоит на плитке и целится в живой канал сетки цифровым окном ~fs/16. Analog LO хопы не догоняет. Walk не участвует.**

---

## 0. Иерархия

```
TILE  →  CHANNEL  →  BIN
           ↑
         SLOT только если native step сетки ≥ 10 МГц на 2.4
```

| Уровень | Счётчик | Единицы | Порог | Кто пишет `CH_TARGET` |
|---|---|---|---|---|
| TILE | NIOS `pwr_hits[]` / `slot_hits[]` **за look 5 мс** | count ячеек, бывших живыми хотя бы в одном снимке | — | никто |
| SLOT | `CH_ENERGY_0..7` | Σ(I²+Q²) uint32 | 0x35 `CH_THR` | только kind step ≥ 10 МГц @ 2.4 |
| CHANNEL | `CH_PWR` + LUT | sat16 mag[31:16] | 0x58 `CH_PWR_THR` | argmax живых |
| BIN | формула центра | signed бин | 0x37 | `center(f0+ch·step)` |

Запрещено: `max(peak.mag)` как score плитки; `next_after`; `g_bin[slot]` на 1-МГц сетке; `mark_slot`; один `CH_THR` на оба счётчика; `CH_TARGET=0` как «сброшено».

| kind | TILE | CHANNEL / BIN |
|---|---|---|
| ELRS/mLRS 1 МГц | `pwr_hits` по 80 | центр канала |
| ISM8 / ofdm-wide 10 МГц @ 2.4 | `slot_hits` по 8 | `g_bin[s]` законен |
| 5.8 digital | `pwr_hits` по n≤3 | центр из LUT |
| пустая сетка | max mag | нет aim, не умная |

---

## 1. Накопление TILE за look — не один кадр

Факт. `CH_PWR` в HDL — сумма **одного** FFT-кадра, `acc` сбрасывается на `mag_last` (`legion_fft_channelize.vhd`). Кадр = 256 сэмплов = **4.57 мкс @ 56 MSPS**. Look обзора = `LEGION_SCAN_QUIET_MS = 5` мс ≈ **1094 кадра**. Один снимок = та же ошибка, что max-mag, только по каналам.

HDL-аккумулятор на look **не делаем** (v3: 24 бит насыщается за миллисекунды; новый M10K не нужен).

### 1.1 SRAM

```
uint16_t pwr_hits[80];   /* снимков, где CH_PWR[ch] ≥ CH_PWR_THR за этот look */
uint16_t slot_hits[8];   /* то же для CH_ENERGY, kind 10 МГц @ 2.4 */
uint8_t  pwr_hyst[80];   /* подряд для stare, не для TILE */
```

80 × uint16 = **160 байт**. 8 × uint16 = 16 байт. Сброс: `enter_look` (каждая плитка), не только `enter_pass`.

### 1.2 Частота чтения

Один проход 80×(`CH_IDX` poke + mux `CH_PWR`) ≈ 80 × (pio_poke + mux_word) ≈ **0.15–0.25 мс** на NIOS 80 МГц (PIO Avalon, плюс CDC `CH_IDX` на `rx_clock`). Это **длиннее одного FFT-кадра**. Читать каждый кадр нельзя и не нужно.

Константа:

```
LEGION_PWR_STRIDE_FRAMES = 64
/* 64 × 256 / 56e6 ≈ 293 мкс. За look 5 мс ≥ 16 снимков. */
```

Правило в `work()` на PASS, после `pwr_ready` (§3):

```
fr = CH_PWR.frame           /* слово [30:24], 7 бит */
если ((fr - last_sweep_fr) & 0x7f) < 64 и уже был sweep:
    return
last_sweep_fr = fr
legion_ch_read_pwr(n)       /* см. §1.3 */
для ch в 0..n-1:
    если pwr[ch] ≥ CH_PWR_THR: pwr_hits[ch]++  /* saturating uint16 */
```

Stride 256 кадров (1.17 мс, ~4 снимка за look) тоже законен, хуже по статистике. Меньше 64 — чтение само длиннее шага, NIOS задыхается. **Дефолт 64.**

Для 10-МГц @ 2.4 тот же stride, 8 слов `CH_ENERGY`, `slot_hits[]`.

### 1.3 Чтение с сверкой idx (CDC)

Слово `CH_PWR`: `[31] valid, [30:24] frame, [23:8] pwr, [7:0] idx`. После poke `CH_IDX` HDL видит индекс через двухтактный CDC.

```
legion_ch_read_pwr(n):
    for ch in 0..n-1:
        for try in 0..3:
            pio_poke(CH_IDX, ch)
            w = mux_word(CH_PWR)
            if (w & 0xff) == ch && (w & 0x80000000):
                pwr[ch] = (w >> 8) & 0xffff
                break
        else:
            pwr[ch] = 0          /* нет валидного слова — не копить */
```

### 1.4 Score плитки

```
count = число ch, у которых pwr_hits[ch] > 0
sum   = Σ pwr_hits[ch]
survey_score_count[look] = count
survey_score_sum[look]   = sum
pick = argmax count; ничья → большая sum; ничья → меньший индекс
next_after УБРАТЬ
```

Пустая сетка: этот путь выключен, score = max mag как сейчас.

Приёмка: плитка A — один CW, один кадр выше порога, остальные тихие. Плитка B — три канала сетки, каждый жил в ≥1 снимке из 16. Pick = B. Если читать один кадр — тест может соврать (FHSS не попал в тот кадр). За look из 16 снимков ELRS 500 Гц даст 2–3 хопа — count ≥ 2.

---

## 2. Sentinel `CH_TARGET`: `0xFF`, не `0`

Факт. Бин 0 — **валидный** FFT-бин (DC). `skip_dc` в channelize его не копит в `CH_PWR`, но xlat/`aim` могут получить FTW=0. `CH_TARGET=0` = «сброшено» и «цель на LO» одновременно.

| Регистр | «нет цели» | «цель есть» |
|---|---|---|
| `CH_TARGET` [7:0] | **`0xFF`** | signed бин, **включая 0 (DC)** |
| `CH_TARGET` [31] | 0 | 1 = произведение aim вооружено |
| `AIM_CH` [7:0] | **`0xFF`** | индекс канала сетки 0..n-1 |
| `AIM_CH` [31] | 0 | 1 = armed (зеркало bit31) |

```
aim_clear:
    pio_poke(CH_TARGET, 0xFF)      /* не 0 */
    AIM_CH = 0xFF
    aim_on = false

aim_to_channel(ch):
    bin = center_bin(ch)           /* может быть 0 */
    AIM_CH = ch
    if Gemini bypass:
        pio_poke(CH_TARGET, bin)   /* bit31=0, bin≠0xFF */
    else:
        pio_poke(CH_TARGET, 0x80000000 | bin)
        AIM_CH |= 0x80000000
```

Readback `CH_TARGET` для хоста: если [7:0]==0xFF → нет бина. Тест hop: до first-valid читается **`0xFF`**, не 0.

`center_bin == 0xFF` (канал вне look) → не вызывать `aim_to_channel`.

---

## 3. First-valid `CH_PWR` после hop

Зеркало хост-Атаки, не новый механизм.

Факт хоста (`tools/sdr_worker.py`): после retune `_discard_left = settle_samples(fs)`, `pending = _rx_gen + 1`; `_wait_attack_psd` не строит спектр, пока `_rx_gen < pending` (кольцо после discard). Плюс `TUNE_DELAY_S = 5 мс`.

Факт NIOS: `SETTLE` уже ждёт `SETTLE_N` сэмплов (хост пишет `fpgaSettleN` = max(4096, round(fs·0.006)) → **6 мс @ 56e6**). Потом защёлкивает кадр в регистре и ждёт **другой** frame (`survey_try_score` / `survey_two_frame`). Это и есть «не жечь stale».

Контракт умной атаки — тот же двухкадровый затвор, распространённый на `CH_PWR`:

```
enter_search (hop ok):
    aim_clear                         /* CH_TARGET=0xFF */
    zero pwr_hits, pwr_hyst, slot_hits, ACTIVE_*
    push_lo_fs + rebuild LUT
    stale_fr = frame(CH_PWR) если valid, иначе 0x80  /* не 0..127 */
    pwr_ready = false
    SETTLE: ждать SETTLE_N сэмплов    /* = _discard_left */

выход из SETTLE (unmute):
    drop_fr = frame(CH_PWR) если valid, иначе stale_fr
    snap_have = true, snap_frame = drop_fr
    pwr_ready = false
    /* не копить, не aim_set(peak) */

FRAME / PASS look:
    w = слово CH_PWR (любой idx, нужен frame+valid)
    если !valid: return
    fr = frame(w)
    если !pwr_ready:
        если fr == drop_fr or fr == stale_fr:
            return                    /* поколение до discard / stale */
        pwr_ready = true              /* первое НОВОЕ поколение, как _rx_gen >= pending */
    /* только здесь stride-чтение и hits */
```

Одного нового кадра после 6 мс SETTLE достаточно: LO уже стоит, stale выкинут. Второй «магический» discard не нужен — `survey_two_frame` как раз отличает stale от нового, не требует трёх кадров.

Запрещено: `fft_fire` / `survey_lock_fire` → `aim_set(peak)` пока сетка жива. Первый aim только из `pick_channel` после `pwr_ready` и хотя бы **одного** stride-снимка (`pwr_hits` обновлён).

При отказе hop: тоже `aim_clear` (`CH_TARGET=0xFF`). Сейчас clear только после успеха.

---

## 4. 5.8 LUT: карточка перекрывает пресет

O4VID3 = три константы 5768.5 / 5789.5 / 5814.5 в `legion_ch_map_bin`. Карточка = `GRID_F0_HZ` + `GRID_STEP_HZ` + `n` (арифметика). Это **разные** таблицы: шаги O4 21 и 25 МГц, одна прогрессия их не повторяет.

Порядок, первый матч побеждает:

```
1. GRID_F0_HZ ≠ 0 AND GRID_STEP_HZ ≠ 0 AND META.n ≠ 0
       → LUT = arithmetic (карточка / оператор / matcher).
         CH_PRESET игнорируется для map_bin.
2. preset == O4VID3
       → три константы. Fallback, если карточка не дала f0/step/n.
3. preset == ELRS / ISM8
       → их таблицы (только S24).
4. иначе
       → пустая сетка (§6.3)
```

Хост:

- «Принять O4 по умолчанию» → пишет preset `O4VID3`, **нули** в 0x52/0x53/`n` (срабатывает п. 2).
- «Оператор задал f0/step/n» → пишет 0x51–0x53, preset может остаться ярлыком UI, NIOS мапит по п. 1.
- Конфликт (и пресет, и ненулевая карточка) → **карточка**. В лог: `lut_source=card`.

v1 не заводит три произвольных центра в регистрах. Кастом, который не арифметика — либо O4VID3, либо оператор принимает приближение f0+i·step.

Контуры 5.8 без изменений: C58-digital только `CH_PWR`; `ch_slot`/`CH_ENERGY` не звать; x40/ADF4351 не предлагать.

---

## 5. Остальное (уже закрыто, здесь как контракт)

### 5.1 `mark_slot`

Вырезать. `ACTIVE_1..3` только из `pwr[ch] ≥ CH_PWR_THR` последнего снимка. HOLD 1-МГц сетки каждый тик (`SETTLE_N` как сейчас) делает `read_pwr` + `pick_channel` + `aim_to_channel`. Живой 10-МГц слот не держит старый бин.

```
center_bin(ch):
    f = f0 + ch * step
    k = round((f - look_lo_hz) * 256 / fs)   /* signed */
    если k < -128 or k > 127: return 0xFF
    return k & 0xff
```

### 5.2 Два порога

| Регистр | Кого |
|---|---|
| 0x35 `CH_THR` uint32 | слот, только 10 МГц @ 2.4 |
| 0x58 `CH_PWR_THR` uint16 | канал |
| 0x36 `CH_HYST` | N **снимков** подряд на уровне, которым целимся |

ELRS/5.8: `CH_PWR_THR≠0`, `CH_THR=0` (слот выключен). ISM8: наоборот. Ноль на неиспользуемом уровне = выкл. `CH_THR=0` больше не значит «суммируй всё как сетку».

### 5.3 Пустая сетка

`n==0` или (`f0==0` и preset MANUAL). PASS по max mag. Stare без `aim_en`, `CH_TARGET=0xFF`. Нет ACTIVE ELRS. UI: «сетка не собрана — не умная». Не подставлять ELRS 2400.4.

### 5.4 `window_limited` в ARM

Оба бита `window_limited` и `f0_unconfirmed` → после первого PASS **нет stare**, второй проход плиток. Оператор снял `f0_unconfirmed` → stare с pick. LUT мапит только бины текущего look.

### 5.5 Gemini

Два пика одного кадра, циклическая дистанция ≥ 16 → bypass, `CH_TARGET[31]=0`, low byte **не** 0xFF если хотим помнить бин, но aim снят. Не целиться в один близнец. Один тон остался → `pick_channel` после `pwr_ready`.

### 5.6 Walk

Не в v1. ARM: `DRFM_STEP_SRC=0`. `PROTO_PERIOD` из матчера не писать.

### 5.7 xlat

Извлечение ~`fs/16` (3.5 МГц @ 56 MSPS), не зарубка. UI: «окно 3.5 МГц вокруг канала N». Live-peak в Smart Attack ARM запрещён.

### 5.8 Host DRFM (не Phase 4 walk)

Хост `planDrfmStrategy` после матчера. NIOS не `switch(kind)`. aim NCO не трогаем. FTW только `LB_FTW0`.

Факты: ExpressLRS `LBT.cpp` — 2.4 500/333 Hz = LoRa SF5 @ BW_0800, символ 39.4 µs, 1/B ≈ 1.23 µs ≈ 64 @ 56 MSPS. Schiller 2023 / proto17 — DroneID SCS 15 кГц, ZC 600/147; CFO ≈ 1 бин ломает пик. ISM8 / OFDM без `GRID_FLAG_ZC` — не OcuSync (CP видео не опубликован). Mux уже ×0.9 (`LEGION_LB_AMP_Q15=29491`) — отвод 0.5 = 16384.

| Карточка | delay0/1 | amp0/1 | сдвиг | walk_step |
|---|---|---|---|---|
| ELRS / ISM8 / пусто / analog / OFDM без ZC / O4VID3 без `zc_hit` | 0 / 64 | 16384 / 16384 | 0 | 0 |
| `GRID_FLAG_ZC` (подтверждённый DroneID) | 0 / 0 | 16384 / 0 | 15 кГц → `lb_shift_hz` → `LB_FTW0` | 0 |

`walk_step=0`: HDL `STEP=0 — застыть`. Lab ARM без FFT оставляет `walk_step=1`. `DRFM_STEP_SRC=0`. `walk_ftw_step=0`.

Оператор бьёт таблицу: `delay0>0`, заданный `delay1` (в т.ч. 0), `|shift|≥0.5`, явный `ftw` / amp / `walk_step`. Панель `0` = таблица.

---

## 6. Регистры

Не трогать 0x32–0x50. `pio_addr` 7 бит, до 0x7F свободно.

| Адрес | Поле | Packing |
|---|---|---|
| 0x51 | `GRID_META` | n[7:0], n_used[15:8], conf[23:16], source[27:24], kind[31:28] |
| 0x52 | `GRID_F0_HZ` | uint32. 0 = нет карточки |
| 0x53 | `GRID_STEP_HZ` | uint32. 0 = нет карточки |
| 0x54 | `GRID_PRI_US` | uint32. 0 = не часы walk |
| 0x55 | `GRID_SHIFT_HZ` | int32 residual |
| 0x56 | `GRID_FLAGS` | bit0 window_limited, bit1 f0_unconfirmed, bit2 zc_hit, bit3 freqcorr_in_band, [7:4] hyp_index, [15:8] hyp_count, [23:16]=16 window_bins |
| 0x57 | reserved | 0 |
| 0x58 | `CH_PWR_THR` | [15:0] uint16 |
| 0x59 | `AIM_CH` | [7:0] канал или **0xFF**, [31] armed |

`source`: 0 none, 1 matcher, 2 preset, 3 operator, 4 second-tile.  
`kind`: 0 unknown, 1 fhss-narrow, 2 ofdm-wide, 3 analog, 4 droneid-zc, 5 cw.

`LEGION_REG_MAX = 0x59`.

`CH_TARGET` (0x37): [7:0] бин или **0xFF**, [31] arm. Не путать с `AIM_CH`.

---

## 7. Фазы

```
L  слух хоста; 5.8 — свой матчер (ширина+ZC / analog), не ELRS
 └─ 0  TILE hits[] за look, stride 64; next_after убрать
      └─ 1  карточки → confirm
           └─ 2  0x51–0x59; LUT: карточка > пресет
                └─ 3  read_pwr + center_bin; mark_slot вырезан;
                     first-valid §3; CH_TARGET=0xFF на hop
```

Фаза 3 не стартует без §1–§3. Фазы 4 (walk) нет.

Фаза L: мульти-гипотезы; ZC или `ofdm-wide`; `|shift|≤200 кГц` @ 2.4 = FreqCorrection; x40+5.8 отказ.

---

## 8. Приёмка

Старые 1–3, 5–9 из поправки плюс закрытие недомолвок:

1. CW на краю слота сильнее хопа → `CH_TARGET` = центр канала, `ACTIVE` один бит.
2. Хоп k→k+3 в слоте → после HYST бин едет, LO стоит.
3. Все `CH_PWR` ниже порога → `CH_TARGET=0xFF`, не старый бин.
4. **Hop плитки.** 2428→2472: `CH_TARGET=0xFF` (не 0) до `pwr_ready`; LUT новый; `pwr_hits` нули; первый aim не с `peak_word`.
5. Пустая сетка → нет ACTIVE, нет aim, UI не «умная».
6. `window_limited`+`f0_unconfirmed` → нет stare.
7. 5.8 xA4: `CH_ENERGY` игнор; карточка с f0/step/n бьёт O4VID3; нули карточки + preset O4VID3 → три константы. x40 отказ.
8. Gemini ≥16 бинов → bypass, bit31=0; один тон → `pick_channel`.
9. `CH_THR` не двигает gate 1 МГц; `CH_PWR_THR` не двигает ISM8.
10. **Look ≠ кадр.** Синтетический FHSS: в первом кадре look каналы тихие, в кадрах 200+ три канала живы. Pick по `pwr_hits` = 3, не 0. Если реализация читает один кадр в конце settle — тест красный.
11. **DC.** Канал сетки совпал с LO (center_bin=0): `CH_TARGET[7:0]=0`, `AIM_CH≠0xFF`, bit31=1. Сброс по-прежнему 0xFF.
12. **First-valid.** Подмена: после hop первое слово `CH_PWR` с тем же frame, что до hop — hits не растут, aim не ставится. Новый frame — растут.

---

## 9. Не входит в v1

Walk / `PROTO_PERIOD`. HDL-аккумулятор `CH_PWR` на секунды. Обобщение `ch_slot` на 5.8. Три произвольных центра в регистрах. Имя OcuSync без ZC. Один LO на 2.4+5.8. `LEGION_CH_N>80`.

---

## 10. Итог одной строкой

TILE копится в NIOS `uint16[80]` каждые 64 кадра за look 5 мс. `CH_TARGET=0xFF` — нет цели, `0` — DC. После hop `CH_PWR` молчит до SETTLE + нового frame. На 5.8 карточка бьёт O4VID3. Aim = центр канала по `CH_PWR`, не слот и не пик.
