# LEGION — поле C-UAS по исходникам, не по описаниям

Дата снятия: 2026-09-21. Звёзды и лицензии — ответы GitHub API в этот день.
README как источник фактов не использовался: смотрелись деревья файлов,
парсеры, разрезы обучения и тесты. Код в `app/` / `firmware/` / `fpga/`
не менялся и из этих репозиториев не копировался.

Правовая рамка та же, что в [compliance.md](compliance.md): лабораторный
генератор, нагрузка 50 Ом, несанкционированное излучение помех вне задачи.

## Короткий ответ

Топовым этот список не становится, если склеить из него «нейросеть 99%»
и чужой передатчик. В коде есть ровно один класс результата, которого у
LEGION нет и который полевые комплекты уже отдают наружу: **серийный номер,
координаты борта, координаты пульта**. Его дают разборщики широковещательных
кадров (Open Drone ID, DJI DroneID), а не классификатор спектрограммы.

Второй честный слой — сенсор на то, что радио не говорит: гармонический
гребень пропеллера (акустика) и карта дальность–Доплер (пассивный радар).
Третий — оболочка трека (CoT / TAK). Всё остальное в списке либо учебный
классификатор с разрезом «куски одной записи в train и в test», либо
каталог выдуманных имён, либо один скрипт и ссылка на магазин.

Сейчас LEGION на приёме делает другое. `pickPriorityTarget` в
`app/src/sense/hold.ts` выбирает самый сильный бин. `lookFromBins` в
`app/src/sense/attackLook.ts` ставит метку `tone | ofdm | cycle | noise |
unknown` по спектральной плоскости и кепстру. Серийника, широты и типа
протокола в этом тракте нет.

## Что брать

Порядок — по тому, что код реально возвращает, а не по числу звёзд.

### 1. Кадр с именем борта, не класс спектрограммы

| Репозиторий | ★ | Лицензия | Что в коде |
|---|---:|---|---|
| [proto17/dji_droneid](https://github.com/proto17/dji_droneid) | 543 | MIT | MATLAB/Octave + C++: корреляция Задова–Чу, OFDM-символ, QPSK, турбо, `process_file.m`. Это демодулятор DroneID, не классификатор |
| [anarkiwi/samples2djidroneid](https://github.com/anarkiwi/samples2djidroneid) | 37 | Apache-2.0 | Обёртка. Сам `process_file.m` в репозитории нет: путь зашит как `/build/dji_droneid/matlab/updated_scripts/process_file.m`. `decode_djidroneid.py` распаковывает 91 байт little-endian |
| [alphafox02/antsdr_dji_droneid](https://github.com/alphafox02/antsdr_dji_droneid) | 123 | нет SPDX | `dji_receiver.py`: TCP legacy (порт 41030, бинарный кадр type `0x01`) и новый текстовый CSV, публикация ZMQ `tcp://127.0.0.1:4221`. Прошивки — zip, не исходники |
| [alphafox02/droneid-go](https://github.com/alphafox02/droneid-go) | 24 | NOASSERTION | Исходников Go нет. В дереве два бинарника `bin/droneid-linux-{x86_64,arm64}`, unit-файлы ZMQ и `install.sh` |
| [ericperret/DroneRX](https://github.com/ericperret/DroneRX) | 4 | нет SPDX | `drone_rx_v3.ino` 3014 строк + `drone_txrx.ino` 2258. Четыре протокола в коде: `FR`, `ODID`, `DJI`, `PAR`, OUI ODID `FA:0B:BC`, BLE Nordic UART, HTML-карта в `drone_page.h` |
| [snstac/dronecot](https://github.com/snstac/dronecot) | 38 | Apache-2.0 | ODID Basic ID + Location → CoT. Тесты отдельно считают кадр без позиции и немой бинарный DJI-кадр |
| [snstac/djicot](https://github.com/snstac/djicot) | 36 | Apache-2.0 | Разбор текстового DJI-лога в CoT, не радиоприёмник |
| [smittix/intercept](https://github.com/smittix/intercept) | 2382 | Apache-2.0 | Платформа. В дереве есть `routes/drone.py`, `utils` и тесты `test_drone_remote_id.py`, `test_drone_rf_detector.py`, плюс ADS-B / Wi-Fi / Bluetooth. Это склейка уже написанных приёмников, не новый физический метод |

Поля, которые `decode_djidroneid.py` достаёт из кадра (`struct`, 91 байт):
`serial_no` (16), `latitude`/`longitude` (масштаб `/174533`), `height`,
`altitude`, три скорости, `yaw`, GPS телефона (`phone_app_latitude/longitude`),
`home_latitude/longitude`, `product_type`, `uuid`. Комментарий в файле
ссылается на разбор Kismet `dot11_ie_221_dji_droneid.h` и публичный разбор
кадра, не на секретный ключ.

`dji_receiver.py` для legacy type `0x01` читает те же сущности другими
смещениями: serial 64 байта, device type 64 байта, double pilot/drone/home,
высоты, частота, скорости E/N/U, RSSI `int16`. Скорость выше 200 м/с
обнуляется. Дальше 50 км от GPS сенсора кадр помечается как мусор.
Координата здесь — содержимое чужого маяка, не пеленг нашего SDR.

OcuSync 4 в этом комплекте **не декодируется локально**. `dragonscope.py`
шлёт hex на удалённый `GET /api/o4online/decrypt` и без `x-api-key`
возвращает пустой `sn`. В репозитории нет функции, которая из I/Q сама
достаёт широту O4.

**Для LEGION.** На уже существующем RX-сканере разбирать кадры, которые
борты сами передают: ODID (раскладка DroneRX / dronecot) и DroneID
(демодулятор proto17 + распаковка 91 байта). Выход — serial, позиция борта,
позиция пульта. Это другой продукт, чем метка `ofdm` по кепстру.

### 2. Честная метрика, прежде чем писать классификатор

Статья David Shulman, arXiv:2607.01025, *How Much Do RF Drone Benchmarks
Overstate?* (HTML-версия снята 2026-09-21). На публичном DroneRF
идентификация AR против Bebop: наивный macro-F1 **0.74**, pooled
leave-one-recording-out **0.46** (уровень случайного угадывания для двух
классов). Абляция относит инфляцию к разрезу по сегментам. Теория: пока
число независимых записей \(R\) мало относительно размерности признаков
(\(2R \lesssim d\)), линейный классификатор запоминает запись, наивная
точность идёт к 1, честная — к байесовской. Синтетика: 10 семян, зазор
около 0.5. Код статьи в репозиториях пользователя `shulm` на GitHub
2026-09-21 не найден (`shulm/echohawk` — акустика, не этот пайплайн).

Тот же разрез сидит в коде списка:

| Репозиторий | Как режется выборка в коде |
|---|---|
| [Al-Sad/DroneRF](https://github.com/Al-Sad/DroneRF) (194★, Apache-2.0) | `Python/Classification.py`: `StratifiedKFold` по сегментам, метрика `accuracy` |
| [kitoweeknd/RFUAV](https://github.com/kitoweeknd/RFUAV) (441★, Apache-2.0) | `tools/random_seg.py`: `random.shuffle` картинок спектрограмм, затем доля в train/val. `TwoStagesDetector` — YOLO по картинке, затем классификатор. Группы записи нет |
| [sgluege/Robust-Drone-Detection-and-Classification](https://github.com/sgluege/Robust-Drone-Detection-and-Classification) (25★, GPL-3.0) | `train_test_split`, стратификация по классу. SNR пишется в отчёт (`0/-10/-20` дБ). `sample_id` из имени файла читается и **не** является группой разреза |
| [rameyjm7/rf-signal-intelligence](https://github.com/rameyjm7/rf-signal-intelligence) (6★) | Пайплайны `40`–`45`, `30`–`34`: `train_test_split`. Отдельного recording-group нет |
| [AvilashaGoswami1103/XGBoost-based-RF-Activity-Detection](https://github.com/AvilashaGoswami1103/XGBoost-based-RF-Activity-Detection) (0★) | Ноутбук `Binary_classifier_80-20.ipynb` печатает accuracy 0.9917 (±0.0111). Соседний ноутбук печатает in-sample accuracy 1.0000 |
| [fg-csp/compact-cnn-drone-detection](https://github.com/fg-csp/compact-cnn-drone-detection) (0★, CC0-1.0) | 41626 jpg, ONNX, исходника обучения нет. `models/C345/benchmark_report.txt`: 5921 параметр, 5388 картинок, accuracy **0.9996**, FPR 0. В отчёте нет идентификатора записи |
| [DaftJun/S3R](https://github.com/DaftJun/S3R) (44★) | Open-set: `experiment_groups/*-known_for_train` против unknown. Это другая задача (известные против неизвестных классов), не полевой приёмник |
| [shulm/echohawk](https://github.com/shulm/echohawk) (4★, MIT) | Акустика. `examples/04_detection_real.py` и `06_train_cnn.py` режут `GroupShuffleSplit` по клипу. `tests/test_smoke.py` рядом делает обычный `train_test_split` 80/20 |

Репозиторий `2_Stage_Drone_Detection_Model` на GitHub отвечает 404.
Двухстадийный код, который существует, — `RFUAV/utils/TwoStagesDetector.py`.

Работа Jakub Kołodziej (WAT), которую заголовок mikrokontroler.pl называет
докторской: страница IEEE Poland AP/AE/MTT (конкурс 27 апреля 2026) и
страница WEL WAT называют её **магистерской**, руководитель Paweł Skokowski.
Тема — двухэтапная детекция: адаптивный порог и лёгкая CNN, прогон на
Raspberry Pi 5. Публичного репозитория с этим кодом 2026-09-21 не найдено.
Награда IEEE/ABB — за текст работы, не за выложенную систему. Брать нечего,
кроме постановки «сначала порог, потом лёгкая сеть, и мерить низкий SNR».

**Для LEGION.** Пока нет своих записей, сгруппированных по полёту, не
публиковать процент узнавания типа. Энергодетектор с порогом над шумом
этой дыры не имеет: он не утверждает имя борта.

### 3. Звук — единственный сенсор списка, который видит борт без радио

Оптоволоконный FPV радио не излучает. Ни один RF-классификатор из списка
его не видит. Это следует из физики канала, и код акустических проектов
как раз мерит пропеллер.

| Репозиторий | ★ | Что делает код |
|---|---:|---|
| [agamrossen/VolAnti](https://github.com/agamrossen/VolAnti) | 380 | `src/detector.py`: кадр 32 мс (hop 512 при 16 кГц, окно 2048), отбеливание спектра, счёт гребенки `score(f0) = зубы − промежутки`, трекер по непрерывности. Поиск f0 70…2000 Гц. Пороги и отрицательные записи вынесены в отдельные модули (`real_negatives.py`, `operating_point.py`), а не спрятаны в accuracy |
| [batear-io/batear](https://github.com/batear-io/batear) | 411, MIT | ESP-IDF: `audio_task.c` — I2S + ESP-DSP FFT, в логе `fundamental_hz`. Рядом MQTT discovery для Home Assistant и LoRa. Это узел, не ноутбук |
| [aranagnost/drone-audio-classification](https://github.com/aranagnost/drone-audio-classification) | 1, MIT | Каскад AST / PaSST / XGBoost по файлам. Тренер, не прибор |
| echohawk | 4 | Решётка, DOA, групповой разрез. 16 python-файлов, полевого узла нет |

**Для LEGION.** Отдельный микрофонный канал с гребенкой, если цель —
радиомолчащий борт. Спектрограммную CNN сюда не ставить: у VolAnti уже
есть измеряемый признак (f0 и гармоники) без обучения на чужих записях.

### 4. Дальность, когда борт молчит и в кадре нет координат

Один SDR по RSS не даёт координат. Это уже зафиксировано на
[AsaqeLee/EW-THREAT-DETECTION-SYSTEM](analysis-related-repos.md). В новом
списке два разных «радара»:

- [Stanislav-sipiko/passive-sdr-radar](https://github.com/Stanislav-sipiko/passive-sdr-radar) (32★, GPL-3.0). В коде есть CAF (`caf.py`), `cfar_2d` с guard/ref и \(P_{fa}\), трекер Калмана с матрицей цен назначения (`track/tracker.py`), LSQ-слияние нескольких отчётов (`fusion_utils.py`). Чисел \(P_d\) по полётам в репозитории нет.
- [mitgor/PLFM_RADAR](https://github.com/mitgor/PLFM_RADAR) (AERIS-10, 587★, SPDX нет). В `9_Firmware/9_2_FPGA` лежат Verilog: `chirp_lut_init.v`, `ddc_400m.v`, `doppler_processor.v`, `cic_decimator_4x_enhanced.v`, `ad9484_interface_400m.v`. Это X-band импульсный ЛЧМ с ФАР, другой диапазон и другая плата. В bladeRF xA4 это не вставляется.
- [sjurfossan/DroneHunterV2](https://github.com/sjurfossan/DroneHunterV2) (4★). Набор CFAR: вейвлет, спектральное вычитание, realtime и dataset. В `cfar_alone_dataset.py` при нулевой сумме TP+FP+FN точность считается как `count_tp/1`. Полевой статистики нет.
- [mtepenner/cuas-radio-interceptor](https://github.com/mtepenner/cuas-radio-interceptor) (5★, MIT). `EstimateDistanceMeters` — Фриис при **заданной** мощности передатчика. Пассивный приёмник эту мощность не измеряет, значит метры в HUD — от константы, не от сигнала.

**Для LEGION.** Дальность без маяка — это CAF/CFAR при внешнем осветителе
(пассивный радар) или несколько пространственно разнесённых постов.
Формула Фрииса с подставленной мощностью дальность не измеряет.

### 5. Оболочка, которую уже ест поле

Детектор без трека снаружи — спектр на экране. Полевые комплекты из списка
отдают Cursor-on-Target.

- [alphafox02/DragonSync](https://github.com/alphafox02/DragonSync) (94★, Apache-2.0): каталог `ingest/`, `sinks/`, `dragonsync.py`, `config.ini`. Сливает входы ZMQ. Сам радиоприёмник живёт в droneid-go / dji_receiver.
- [alphafox02/WarDragon](https://github.com/alphafox02/WarDragon) (40★): документация и `index.html`, не детектор. [wardragon-console](https://github.com/alphafox02/wardragon-console) (8★, MIT) — состояние комплекта, сертификаты, сеть.
- [DECTYR/ha-integration](https://github.com/DECTYR/ha-integration) (2★, MIT): MQTT-сущности Home Assistant для чужого прибора RX-5. Детектора в репозитории нет.
- GovData «Luftlagebild und Drohnendetektionen 2025/26» (проект AllgAir, HS Kempten): набор траекторий ADS-B, FLARM, Mode-S, DRID и толчков DedroneTracker.AI, март 2025 – март 2026. Это данные, не алгоритм. Мультилатерация в описании набора делается отдельными сенсорами, не одним приёмником.
- BlueBird Tech Chuyka 3.0 — закрытое изделие, исходников нет. Сайт производителя (снят 2026-09-21): пассивный приём **аналогового** видео, три полосы 900–1800, 2870–4080, 4860–6060 МГц, цикл скана 4–8 с, заявка «до 4000 м» со звёздочкой, питание 2S, до 650 г. Новость об апгрейде плат 1.3.8 (покупка с апреля 2026): четвёртая полоса 6–8.8 ГГц и расширение 3.3 ГГц до 2860–4500 МГц. Независимой измерения дальности в открытом коде нет. Близкий по смыслу кусок для LEGION — энергодетектор в этих видеополосах, не «имя DJI».
- VD:Розвідка Ворога — телеграм-канал @VictoryDrones. Программного репозитория нет.
- Строка «Беспилотник + Дрон» на один репозиторий с кодом не садится.
- [Ibtisam-Mohammad/awesome-defense](https://github.com/Ibtisam-Mohammad/awesome-defense) (28★): список и два скрипта проверки списка.
- [TarczaAntydronowa/tarcza-antydronowa](https://github.com/TarczaAntydronowa/tarcza-antydronowa) (30★): 0 файлов исходников. Каталог `library/` — markdown (статьи, патенты, видео).
- [gebruder/kampfraum](https://github.com/gebruder/kampfraum) (0★, MIT): `scripts/normalize.py` пишет Parquet (`drone_model`, `sensor_type`, `snr_db`, `signal_data`). Детектора нет.
- [ScaleRF/QuadRF](https://github.com/ScaleRF/QuadRF) (484★): Soapy-драйвер `mipi`, не детектор дронов. Сильный открытый SDR-узел, другой прибор.

## Что выглядит как система и ей не является

Проверено по файлам, не по описанию.

| Имя | Факт из дерева |
|---|---|
| [Nordic-Drone-Guard/ndg-detection-core](https://github.com/Nordic-Drone-Guard/ndg-detection-core) (0★, архив) | `sdr_interface.py` всегда пишет `"burst_pattern": "unknown"`. `patterns.json` — 100 записей с именами вида «Skydio Mavic», «iFlight Mavic», «Parrot HS110», «Xiaomi Anafi» и номером. Совпадение по burst в `matcher.py` требует равенства строк, сканер такую строку не производит |
| [pingbiqi/Anti-Drone-System-C-UAS-Detection-Jamming-Defense](https://github.com/pingbiqi/Anti-Drone-System-C-UAS-Detection-Jamming-Defense) (3★, MIT) | Один файл `scripts/defense_range_sim.py`: дальность из подставленных мощности, усиления и чувствительности, в конце URL магазина. Приёмника нет |
| [mariusbayizere/DroneShield-AI](https://github.com/mariusbayizere/DroneShield-AI) (0★, MIT) | 120 python-файлов. `tests/test_pipeline_stub.py` прямо говорит: dummy emitter, stub fusion, это не тест точности. Слияние трёх фиктивных confidence 0.8/0.6/0.4 даёт 0.6 |
| [Runtime-Slayers/Multi-Modal-AI-Fusion-for-Counter-UAS-Detection](https://github.com/Runtime-Slayers/Multi-Modal-AI-Fusion-for-Counter-UAS-Detection) (0★) | `simulator.py` рисует радар/звук/картинку из таблицы RPM и RCS (12 классов, включая птиц и автомобиль). Полевых I/Q нет |
| [kashviajay/AI-Powered-Anti-Drone-Surveillance-System](https://github.com/kashviajay/AI-Powered-Anti-Drone-Surveillance-System) (1★) | `threat_engine.py`: если акустическая метка не передана, `np.random.choice([0, 1])`, статус `"SIMULATED"` |
| [doguilmak/Drone-Detection-YOLOv8x](https://github.com/doguilmak/Drone-Detection-YOLOv8x) (147★, MIT) | Зрение, не радио. В этот проход дерево весов не разбиралось; для тракта LEGION это другой сенсор |
| cuas-radio-interceptor, протоколы | `MatchELRS`: среднее интервала прыжков в окне 3.5–4.5 мс и формула уверенности, потолок 0.98. `MatchOcuSync`: окно 7.0–9.5 мс и занятость 2400–2485 МГц. Демодулятора, серийника и проверки кадра нет. Уверенность растёт с числом всплесков |

## Протоколы управления — парсеры, не детекторы

Их имеет смысл знать, потому что FPV часто не шлёт DroneID.

| Репозиторий | ★ | Факт |
|---|---:|---|
| [olliw42/mLRS](https://github.com/olliw42/mLRS) | 612, GPL-3.0 | Полный LoRa-линк 2.4 / 915 / 868 / 433 МГц, в дереве есть `crsf_interface_tx.h`. Это радиостанция борта, не наблюдатель |
| [jettify/uf-crsf](https://github.com/jettify/uf-crsf) | 20, Apache-2.0 | `no_std` разбор CRSF, пакеты RC, батарея, гироскоп. Кадр до 64 байт |
| [iOperator/CRSF-HLA](https://github.com/iOperator/CRSF-HLA) | 33, Apache-2.0 | Один анализатор Saleae Logic |
| [Diamond-D0gs/GNU_Radio_ExpressLRS](https://github.com/Diamond-D0gs/GNU_Radio_ExpressLRS) | 14 | И приёмник, и передатчик flowgraph. Передающую половину не переносить |
| [wetheredge/expresslrs-uid-lookup](https://github.com/wetheredge/expresslrs-uid-lookup) | 3, MIT, архив | Поиск UID привязки по радужной таблице. В прибор это не класть: это не детекция присутствия, а подбор идентификатора линка |

WMJRadar ([zplszz/WMJRadar](https://github.com/zplszz/WMJRadar), 15★, GPL-3.0) —
радио RoboMaster: `phy.py` содержит гауссов фильтр и FM-демодулятор, плюс
`anti_drone/infer_anti_drone.py`. Это командный стек соревнования, не
открытый C-UAS общего назначения.

## Передатчики помех

В списке есть CleverJAM, jamrf, UAV-Jamming-Scrips, реактивный HackRF-jammer,
DroneCMD (8★, MIT: рядом с `capture/detector.py` лежат `core/replay.py`,
`core/fhss.py` и демодуляторы). Их содержимое здесь не разбиралось и в
LEGION не переносится. Идентификации борта они не добавляют. Несанкционированное
создание помех вне лабораторной нагрузки противоречит [compliance.md](compliance.md).

## Чего не хватает LEGION, если цель — полевой прибор, а не ещё один процент

1. Разбор ODID и DJI DroneID на RX, с выходом serial / борт / пульт. Демодулятор — proto17 (MIT), распаковка кадра — `decode_djidroneid.py`, транспорт в TAK — dronecot. Бинарник droneid-go и удалённый decrypt O4 не воспроизводятся из исходников.
2. Отдельная ветка «видеополоса без имени»: энергодетектор в полосах, которые закрытое изделие Chuyka обходит циклом 4–8 с (1.2 / 3.3 / 5.8 ГГц и, с 2026, 6–8.8). Метка — «аналоговый видеосигнал», не «DJI».
3. Любая будущая классификация типа — только leave-one-recording-out. Цифры 0.99 из XGBoost-ноутбука и compact-cnn в документ прибора не переписывать: статья 2607.01025 на DroneRF показывает, куда они падают.
4. Если нужен радиомолчащий борт — гребенка VolAnti/batear, отдельным сенсором.
5. Если нужны метры без маяка — CAF/CFAR пассивного радара или несколько постов, как в наборе AllgAir. Один бин dBm метры не даёт.
6. Наружу — CoT, если потребитель — TAK. DragonSync показывает стык (ZMQ внутрь, CoT/MQTT наружу), не новый алгоритм детекции.

Каталог из 100 выдуманных имён, stub-fusion, симулятор с таблицей RPM,
случайная акустическая метка и Фриис с подставленной мощностью в этот
список не входят.
