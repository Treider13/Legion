# LEGION lab host (ПК): приём I/Q → GPU → классификация → hop map → FPGA

Реализация шагов 3–9 ТЗ лаборатории bladeRF 2.0 micro xA4 + RTX 5050.
FPGA-часть (timing/M10K, шаги 2.5–2.7) — отдельная задача Quartus, сюда не
входит. Реактивная петля (detector+gate+look_through+DRFM) остаётся в FPGA
(шаг 7.4); ПК — надзорный контур.

## Архитектура и одно физическое ограничение

**USB на FX3 — один владелец** (подтверждено в самом репозитории:
`fpga/host/legion_gateway.py` errno 16 «USB занят», `tools/sdr_worker.py`
SoapySDR #225: стрим и регистровый агент одновременно плату не делят).
Отсюда два следствия, зафиксированные в коде:

1. **Шаг 3.9 невозможен как второй процесс** `bladeRF-cli -e "rx status"` —
   тот получил бы device busy. Реализация: одна интерактивная сессия
   `bladeRF-cli -i` (`cli_session.py`), `rx status` опрашивается в ней же
   каждые 100 мс, плюс счётчик асинхронных overrun-строк из stdout сессии,
   плюс байтовая сверка потока (80 МБ/с × 60 с) как жёсткая проверка.
2. **Шаг 9 не может писать регистры во время CLI-стрима.** Реализация —
   burst-циклы (`pipeline integrate`): стрим → rx stop → `FpgaBridge`
   (репозиторный `UsbTransport` + `legion_fpga.py`, API как есть) →
   профиль класса → release → стрим. Критерий 9.4 (<10 мс) измеряется как
   задержка «кадр → решение+запись при захваченном USB»; цена перехвата
   USB (`usb_handoff_ms`) логируется отдельно и честно в критерий не
   входит. Реальное время реакции на детект — мкс, обеспечивает FPGA-петля.

## Карта шагов → код

| Шаг ТЗ | Модуль | Критерий |
|---|---|---|
| 3.1–3.6 mkfifo+CLI | `cli_session.py`, `fifo_source.py`, `scripts/rx_lab.sh` | — |
| 3.7 SC16_Q11 | `frames.py` (int16 LE, I/Q, /2048) | — |
| 3.8 C-читатель | `reader/creader.c` (read(2) в numpy, без f.read) | — |
| 3.9–3.10 overrun | `overrun.py` (100 мс poll + async + байты) | overruns=0/60 с |
| 4.2–4.5 PFB GPU | `pfb.py` (`cupyx.signal.channelize_poly` при taps≤32 и zero-overlap, иначе свой PFB) | кадр <5 мс |
| 4.6 CH_PWR_gpu | `pfb.py::ch_power` (в FPGA НЕ пишется) | — |
| 4.7 метки | `creader.c` CLOCK_MONOTONIC + `frames.py` sample_count | — |
| 5.1 датасеты | `classify/datasets.py` (DroneRFa/z/AttackRF деревья) | — |
| 5.3 синтетика | `synth/protocols.py` (12 классов, ground truth meta) | — |
| 5.4 CNN→ONNX→TRT | `classify/{model,train,export_trt,infer}.py` | acc>0.95 (отд. этап 5.6) |
| 6 hop map | `hopmap.py` (темп, период+Markov-1, предсказание) | >0.7 на 10 скачков |
| 7.1–7.2 регистры | `fpga_control.py::PROFILES` (только `legion_fpga.py`) | amp0+amp1≤1.0 жёстко |
| 7.3 калибровка | `fpga_control.py::calibrate_amp` + `measure_imd3_db` | IMD3≤−30 dBc |
| 8 визуализация | `ipc.py` (UDP JSON) → `viewer.py` (PyQt6/pyqtgraph, отдельный процесс) | 60 FPS |
| 9.3 LO | `fpga_control.LoManager` (settle ≥100 мкс, факт 6 мс) | — |
| 9.4 петля | `pipeline.py integrate/bench` | decision <10 мс |

## Запуск (лаборатория)

```bash
pip install -r host/requirements.txt          # CPU / тесты
pip install -r host/requirements-lab.txt      # + CUDA CuPy/torch/TRT/PyQt6
python3 -m legion_rx.reader.build           # C-читатель (gcc)
cd host && export PYTHONPATH=$PWD

# Шаг 3 (60 с, критерий overruns=0):
python3 -m legion_rx.pipeline rx-cli --duration-s 60 --publish
# Шаг 4 (+PFB GPU, критерий кадр<5 мс):
python3 -m legion_rx.pipeline gpu --duration-s 60 --publish
# Шаг 5 (после обучения — отдельный этап 5.6):
python3 -m legion_rx.classify.train --synth-per-class 400 \
    --dronerf /data/DroneRFa /data/DroneRFz /data/DroneAttackRF \
    --epochs 40 --out models/run1
python3 -m legion_rx.classify.export_trt models/run1/model.onnx \
    models/run1/model.engine --labels models/run1/labels.json --bench
python3 -m legion_rx.pipeline classify --engine models/run1/model.engine \
    --labels models/run1/labels.json --duration-s 60 --publish
# Шаг 9 (интеграция, LO по карте классов):
python3 -m legion_rx.pipeline integrate \
    --profiles elrs_24,crossfire_fsk,analog_fpv \
    --engine models/run1/model.engine --labels models/run1/labels.json \
    --cycles 6 --publish
# Шаг 8 (отдельный терминал/процесс):
python3 -m legion_rx.viewer --port 5590
# Офлайн-проверка критериев 6.4/9.4 без железа:
python3 -m legion_rx.pipeline bench --protocol elrs_24 --duration-s 0.5 --cpu
```

## Тесты (без железа)

```bash
pytest host/tests -q   # регрессия + RBF/FHSS

# RBF 72 МГц / 36 MSPS (лаборатория, нужен bladeRF):
#   flash legionxA4-2026-10-11_23.08.28/legionxA4.rbf
#   md5 bd0316396c32bb6e615061f3bdf413fe
#   bladeRF-cli -e "set samplerate rx 36M"
#   bladeRF-cli -e "print samplerate rx"   # 36000000
#   rx start 60с; rx status → rx_overruns=0
#   DATA_CLK=144 МГц. overruns>0 → AD9361 0x006.
# FSM (без железа): python3 -m legion_rx.pipeline cognitive --cpu
```

Покрыто: C-читатель (байты/метки/EOF), парсер rx status, Q15-таблица ТЗ,
жёсткая сумма amp0+amp1≤1.0, apply_profile на FakeTransport (регистры
0x02/0x25/0x27/0x28/0x32/0x33 + ARM lb_gated), калибровка amp (откат на
шаг), IMD3 (кубическая нелинейность vs теория), PFB (тон→свой канал),
синтез (темп скачков/периоды/полоса/пик≤1.0), hop map (>0.7/10), CNN
forward, DroneRF-загрузчик, torch-инференс, train smoke, bench пайплайна.

## Замеры bench (синтез → PFB → hop map, этот ПК, CPU-backend)

| Протокол | Темп истина | Темп измерен | Метод | acc 10 скачков | 6.4 |
|---|---|---|---|---|---|
| ELRS 2.4 (1000 Гц, 0.6 с) | 1000 | 1000.0 | gap-mode, таблица 256 | 1.0 | DONE |
| ELRS 900 (200 Гц, 0.6 с) | 200 | 200.0 | gap-mode, таблица ~198 | 1.0 | DONE |
| OrangeRX FHSS (500 Гц, 0.6 с) | 500 | 500.0 | gap-mode, таблица 93 | 0.9 | DONE |
| Crossfire FSK (150 Гц, 1.2 с) | 150 | 153.85 | scored, таблица 333 | 0.8–0.9 | DONE |
| Crossfire LoRa (50 Гц, 4 с) | 50 | 50.0 | scored | 1.0 | DONE |
| MAVLink/TTLRS/Miller/FPV | — | — | нет FHSS | n/a | n/a |
| Wi-Fi/BT | 1600 | — | AFH криптографический | n/a | n/a |

Физика окон наблюдения (не баг): фазовая таблица требует ≥ 2 циклов FHSS
(ELRS 256 скачков ≈ 0.3 с видимых; Crossfire 50×6.67 мс ≈ 0.7 с; 50 Гц —
секунды). BT/AFH слепо не предсказуем — критерий помечен n/a честно.
Видимый темп < истинного, когда таблица шире 20 МГц окна (ELRS 2.4:
видно ~190/1000 Гц) — истинный темп восстанавливается из кратности
интервалов (метод gap-mode/scored в отчёте).

Алгоритм hop map (hopmap.py): адаптивный порог (median+6·MAD) → гистерезис
по margin (хвост/фронт пачки) → амплитудные ворота onset'а (протечки) →
слияние 1-кадровых пар при dwell≥3 (Carson-размаз) → dwell (мода
интервалов + автокорреляция) → фазовая таблица периода (±1 бин,
wildcard-пропуски) → предсказание table/period/Markov-1, скоринг ±1 бин.

## Что НЕ проверить без лаборатории (честно)

- overruns=0 за 60 с (нужен bladeRF на USB 3.0);
- GPU-латентность кадра <5 мс и петля <10 мс (нужна RTX 5050 + CuPy);
- IMD3 реального тракта (нужен второй приёмник/анализатор);
- acc>0.95 (отдельный этап обучения на DroneRFa + синтетике);
- TRT `--bench` сборка движка на Blackwell; 60 FPS вьювера;
- FPGA timing/M10K — шаги 2.5–2.7, отдельная задача Quartus.

## Когнитивный контур FHSS-памяти (п.1–12 ТЗ, 11.10.2026)

```bash
cd host && export PYTHONPATH=$PWD
# bench когнитивного контура (FSM end-to-end, FakeTransport):
python3 -m legion_rx.pipeline cognitive --duration-s 1.0 --publish
```

Модули: `corridor.py` ([G1] burst-детектор + [G2] байес P(hopping)),
`hop_recorder.py` ([G6] FHSDT/FHSDC), `pattern_store.py` ([G5] ID,
find_match, sequence_type), `cognitive.py` (FSM), `effectiveness_monitor.py`
(PDR-прокси), `drift_detector.py` (LP<0.7×3), `fpga_control.apply_predictive_jam`
(confirmed+sub-only, [G4]), `fpga_preload.py` (LUT+GRID через legion_fpga.py).
Нейросеть — 3 класса (drone/wifi/noise, `--no-group3` откат). Сетка PFB —
адаптивная (коридор/200 кГц). DDPG [G3] — отдельный этап RL (не заглушка:
fallback — Markov-1 из HopTracker).

## Примечания после аудита (11.10.2026)

- `rx config`: buffers=32, **num_transfers=16** (Nuand [F1]); эскалация
  overrun: рестарт стрима 20→10 MSPS, порог 10 (`overrun.py`).
- ELRS 900: модель SX127x (200 Гц LoRa). Для LR1121: `synth_elrs_900(
  hardware="lr1121")` — 1000 Гц FSK. Выбор — за железом стенда.
- Q15: база 32768 (0.85→27853), 1.0 clamp→32767.
- DroneRF loader верифицирован на семействе (CSV (N,2) I,Q); DroneRFa
  (IEEE Dataport) — лейаут проверить в лабе.
- Внешний PA с GPIO не используется (см. RESOURCES.md).
