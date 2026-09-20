# ЛЕГИОН — Графит 13

Визуальное оформление выполнено по выбранному концепту №13 на основе `main`:
`f8c1fcbd7c66d5165ca37705ffcc1f93527c12a9`.

## Что реализовано

- Фон с графитовой архитектурой и кинематографическим светом, плавный 42-секундный дрейф фона, отдельные частицы в Three.js.
- Исходный `CyborgEye.tsx` сохранён побайтово. Его геометрия, материалы, поведение, шейдеры и анимация не переписывались.
- Существующая сцена остаётся лениво загружаемой. React Three Fiber, Three.js, постобработка и GSAP уже входят в зависимости проекта; новых пакетов не добавлено.
- Платиновые кромки, тёмные панели, согласованная типографика; оформление главного экрана и существующих окон настроек.
- Штатный `SpectrumScope` размещён на главном экране SDR; штатный `FrequencyField` сохранён ниже как история. Обработка входных сигналов, транспорт, команды и обработчики запуска не переписывались.
- Подписи осей вынесены за пределы области отсечения графика; добавлены названия осей и тонкая сетка. Из начального пустого отображения истории убрана декоративная линия, добавлено ожидание данных.
- Верхние переходы ведут к обзору, спектру, истории и существующему окну настроек. Карточки показывают настройки и оформление, а не выдуманные измерения.
- Переключение движения фона, сохранение предпочтения, учёт системного уменьшения движения, пауза декоративных анимаций при скрытой странице.
- Вступительная анимация говорит об оформлении; прежние декоративные строки о якобы успешных аппаратных самотестах удалены. Добавлена очистка GSAP timeline.
- Из исходника удалены две переменные, которые только объявлялись и обнулялись, но нигде не читались: это устранило две исходные ошибки TypeScript без изменения поведения.

## Проверка

`npm run build` проходит без отключения проверок TypeScript. Линтер изменённых компонентов проходит.

13 браузерных проверок пройдены: WebGL и холсты, широкий и узкий экран, настройки, Escape, переход к истории, выключение фоновой анимации, сохранение предпочтения, системное уменьшение движения и завершение вступления. Исключений JavaScript в этих сценариях нет. Проверка выполнена в Chrome с программным WebGL; скорость на физической видеокарте не измерялась. Аппаратный обмен и рабочие режимы оборудования не запускались.

Остаются предупреждения Vite об уже существующих смешанных статических/динамических импортах Tauri; они не останавливают сборку.

## Точность относительно эскиза

Материалы, архитектура фона, цветовая схема и общая композиция перенесены в работающий интерфейс. Это не пиксельная копия растровой картинки: сохранены настоящие элементы спектра и существующие действия, поэтому тексты, верхняя навигация и служебные карточки отличаются от генеративного эскиза. Неподдерживаемых кнопок и фиктивных показаний из картинки не добавлено. Слоумо относится к фону, а не к обновлению графиков или исходному глазу.

## Установка изменений

Архив содержит `graphite.patch` с текстовыми изменениями и фоновым изображением. Из корня своего репозитория:

```sh
git apply --check /путь/к/graphite.patch
git apply /путь/к/graphite.patch
cd app
npm ci
npm run build
npm run dev
```

Патч рассчитан на указанную версию `main`. Если проверка применимости сообщает о конфликте, сначала согласуйте изменения с новой версией файлов; не заменяйте файлы вслепую. Применимость патча к чистому сохранённому основанию проверена.

## Фоновый материал

Файл `app/src/assets/graphite-architecture.png` создан встроенным imagegen из утверждённого эскиза №13. Глаз и интерфейс из фонового изображения удалены; сам глаз рендерится отдельно исходным компонентом.

Промпт: Create ONLY the graphite architectural background environment seen in the TOP THIRD of the reference image. Remove ALL user interface, ALL text, ALL charts, ALL logos, and remove the entire orange mechanical eye including its hoops and orange particles. Preserve the existing black industrial cylindrical tunnel architecture with a massive rough graphite segmented arch, intricately textured carbon-black metal panels, subtle gray specular edge highlights, soft cinematic white diagonal light shafts and charcoal fog. Camera looks down symmetrical graphite tunnel. This is a background plate for a live 3D eye that will be overlaid later. Keep CENTER DARK AND EMPTY. Wide panorama aspect 3:1. No orange, no eye, no mechanical orb, no UI or writing, no screens, no measurement graphics, no control surfaces. Detailed physically rendered matte charcoal materials, restrained film lighting, expensive realistic production design. Match the reference's upper background architectural shapes, tonal range and materials as closely as possible. Make the big outer arch intersect the left and right margins at one-quarter and three-quarters of width, with the center softly receding into darkness.
