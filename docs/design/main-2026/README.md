# LEGION — главное окно 2026 (макеты на утверждение)

3D-глаз **не трогаем**. На кадрах — плейсхолдер-кольцо. Сетка и хром — новые.

| Файл | Вариант | Зачем смотреть |
|---|---|---|
| `v1-ion-lattice.png` | Ion Lattice | 3D-решётка частот под глазом — этого нет у GQRX/SDR++/SDR# |
| `v1-start-sheet.png` | тот же + лист СТАРТ | коридор + тип сигнала из `WAVE_CATALOG` |
| `v2-phosphor-ribbon.png` | Phosphor Ribbon | спектр + водопад, как просят операторы |
| `v3-amber-reticle.png` | Amber Reticle | тактический HUD |
| `v4-void-glass.png` | Void Glass | cinematic glass (язык Midnight Glass, не копия Linear) |
| `v5-chrome-bezel.png` | Chrome Bezel | металлическая рамка прибора |

Переснять:

```bash
cd /workspace/docs/design/main-2026 && python3 shoot.py
```
