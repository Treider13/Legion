# LEGION — варианты дизайна консоли (на утверждение, НЕ основной дизайн)

Пять тем для консоли (вкладка ТИП СИГНАЛА как референс). 3D-глаз не трогаем —
на макетах он плейсхолдер-кольцо. Рендер — реальный HTML/CSS на токенах
(не картинка-фантазия): `index.html` + `shoot.mts` → PNG ниже.

| # | Вариант | Файл | Характер |
|---|---|---|---|
| 1 | **Aurora Pro** | `v1-aurora-pro.png` | эволюция текущей темы: тёмное стекло, бирюза, плотнее телеметрия |
| 2 | **Lab Instrument** | `v2-lab-instrument.png` | осциллограф/RF-прибор: фосфор, сетка, моноширинный |
| 3 | **Tactical HUD** | `v3-tactical-hud.png` | милитари-HUD: янтарь, сканлайны, трафарет, ромб-глаз |
| 4 | **Mission Control** | `v4-mission-control.png` | NASA-стиль: глубокий синий, чистые карточки данных |
| 5 | **Minimal Pro** | `v5-minimal-pro.png` | светлый девтул (Linear/Vercel-подобный), воздух, точная типографика |

Перерендерить после правок `index.html`:
```bash
cd app && OUT_DIR=$PWD/../docs/design/variants HTML_PATH=$PWD/../docs/design/variants/index.html \
  npx tsx ../docs/design/variants/shoot.mts
```
(скрипт копируется в app/scripts для доступа к puppeteer-core — см. историю коммитов;
в CI не входит, ручной инструмент дизайна.)
