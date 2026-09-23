import type { CaptureView } from "./recording";

export type DemoModeId =
  | "attack"
  | "sweep"
  | "band"
  | "hop"
  | "fpga"
  | "air"
  | "solo"
  | "esp32"
  | "position";

export type StageKind = "seek" | "tape" | "walk" | "grid" | "lamp" | "map";

export interface DemoMode {
  id: DemoModeId;
  title: string;
  group: "SDR" | "ESP32" | "Карта";
  scanner: boolean;
  hostHints: boolean;
  summary: string;
}

export interface Slide {
  key: string;
  kicker: string;
  title: string;
  text: string;
}

export const DEMO_MODES: readonly DemoMode[] = [
  {
    id: "attack",
    title: "Атака",
    group: "SDR",
    scanner: true,
    hostHints: true,
    summary: "Сканер стоит на центре снимка. Подсказка держится 4 секунды.",
  },
  {
    id: "sweep",
    title: "Качание",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "TX идёт к краю коридора и разворачивается. Сканер не участвует.",
  },
  {
    id: "band",
    title: "Сплошная",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "TX по кругу: с конца коридора снова в начало. Сканер не участвует.",
  },
  {
    id: "hop",
    title: "Случайная",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "TX прыгает по коридору. Сканер не участвует.",
  },
  {
    id: "fpga",
    title: "Умная атака",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "После старта хозяин — плата. Сканер хоста в круге не участвует.",
  },
  {
    id: "air",
    title: "Эфир + FPGA",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "Без онбордового обзора: детектор смотрит энергию канала.",
  },
  {
    id: "solo",
    title: "Только FPGA",
    group: "SDR",
    scanner: false,
    hostHints: false,
    summary: "Эфир не слушаем. По сетке идёт генерация тона или волны.",
  },
  {
    id: "esp32",
    title: "Коридор",
    group: "ESP32",
    scanner: false,
    hostHints: false,
    summary: "ESP32 ведёт ADF4351 по коридору. Антенны скана нет.",
  },
  {
    id: "position",
    title: "Позиция",
    group: "Карта",
    scanner: false,
    hostHints: false,
    summary: "Карта: дойдёт ли сигнал. Это отдельная сцена, не лента сканера.",
  },
];

export function modeById(id: DemoModeId): DemoMode {
  return DEMO_MODES.find((mode) => mode.id === id) ?? DEMO_MODES[0];
}

export function stageFor(id: DemoModeId, slideKey: string): StageKind {
  if (id === "attack") return slideKey === "seek" ? "seek" : "tape";
  if (id === "sweep" || id === "band" || id === "hop") return "walk";
  if (id === "solo" || id === "esp32") return "grid";
  if (id === "fpga" || id === "air") return "lamp";
  return "map";
}

function mhz(hz: number): string {
  return (hz / 1e6).toLocaleString("ru-RU", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function khz(hz: number): string {
  return Math.round(hz / 1e3).toLocaleString("ru-RU");
}

function ms(seconds: number): string {
  return (seconds * 1000).toLocaleString("ru-RU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function slidesFor(id: DemoModeId, cap: CaptureView): Slide[] {
  const center = mhz(cap.meta.centerHz);
  const lo = mhz(cap.loHz);
  const hi = mhz(cap.hiHz);
  const peak = mhz(cap.peakHz);
  const db = Math.round(cap.peakDb).toLocaleString("ru-RU");
  const width = khz(cap.widthHz);
  const dur = ms(cap.seconds);
  const band = `${lo}…${hi} МГц`;

  if (id === "attack") {
    return [
      {
        key: "seek",
        kicker: "Сканер",
        title: "Обход коридора",
        text: `Коридор снимка ${band}. Запись одна — центр ${center} МГц. На остальных стоянках файла нет.`,
      },
      {
        key: "dwell",
        kicker: "Сканер",
        title: "Стоянка",
        text: `Сканер стоит на ${center} МГц и крутит снимок ${dur} мс по кругу.`,
      },
      {
        key: "peak",
        kicker: "Энергия",
        title: "Что в записи",
        text: `Сильнее всего около ${peak} МГц: ${db} дБ над серединой спектра, ширина по уровню −6 дБ около ${width} кГц.`,
      },
      {
        key: "type",
        kicker: "Тип",
        title: "Что известно",
        text: "В файле Signal Hound записаны устройство, центр и частота дискретизации. Имени модуляции там нет.",
      },
      {
        key: "advice",
        kicker: "Атака",
        title: "Подсказка оператору",
        text: "В атаке оператор читает стоянку и сам решает про передачу. Здесь команда на плату не уходит.",
      },
    ];
  }

  if (id === "sweep" || id === "band" || id === "hop") {
    const how =
      id === "sweep"
        ? "Качание ведёт TX к краю коридора и разворачивает луч."
        : id === "band"
          ? "Сплошная ведёт TX по кругу: с конца коридора снова в начало."
          : "Случайная прыгает TX по коридору.";
    return [
      { key: "how", kicker: "TX", title: modeById(id).title, text: `${how} Коридор на рисунке — полоса этого снимка, ${band}.` },
      { key: "scan", kicker: "Сканер", title: "Сканер не участвует", text: "Ленты спектра в этом режиме нет. Запись RX остаётся в стороне." },
      { key: "hints", kicker: "Подсказки", title: "Подсказок хоста нет", text: "Их пишет режим «Атака», пока сканер смотрит стоянку." },
      { key: "tx", kicker: "Демо", title: "Только рисунок", text: "Частота на линейке нарисована. На плату команда не уходит." },
    ];
  }

  if (id === "fpga") {
    return [
      {
        key: "owner",
        kicker: "Умная атака",
        title: "Хозяин — плата",
        text: "После старта энергию смотрит плата. Сканер хоста в круге не участвует.",
      },
      {
        key: "hints",
        kicker: "Подсказки",
        title: "Подсказок хоста нет",
        text: "Лента подсказок есть в режиме «Атака». Здесь её нет.",
      },
      {
        key: "file",
        kicker: "Снимок",
        title: "Запись рядом",
        text: `В файле энергия около ${peak} МГц, ${db} дБ над серединой. Гейт платы этот контур не считает.`,
      },
      {
        key: "usb",
        kicker: "Связь",
        title: "USB вне круга",
        text: "USB не стоит в круге «увидел → усилитель». Ноутбук в этом режиме только наблюдатель.",
      },
    ];
  }

  if (id === "air") {
    return [
      {
        key: "survey",
        kicker: "Эфир + FPGA",
        title: "Без онбордового обзора",
        text: "Детектор смотрит энергию канала. Ленты сканера нет.",
      },
      {
        key: "energy",
        kicker: "Канал",
        title: "Энергия снимка",
        text: `В записи пик около ${peak} МГц, ${db} дБ над серединой спектра. Порог платы сюда не подставлен.`,
      },
      {
        key: "relay",
        kicker: "Тракт",
        title: "Ретрансляция",
        text: "Есть энергия — тот же RX шёл бы на TX. В демо ретрансляция не запускается.",
      },
    ];
  }

  if (id === "solo") {
    return [
      {
        key: "quiet",
        kicker: "Только FPGA",
        title: "Эфир не слушаем",
        text: "Генерация тона или волны из памяти. Запись RX в этом режиме не играет.",
      },
      {
        key: "grid",
        kicker: "Сетка",
        title: "Стоянки коридора",
        text: `Рисунок шагает по ${band}. Это сетка генерации, не обзор антенны.`,
      },
      {
        key: "hints",
        kicker: "Подсказки",
        title: "Подсказок сканера нет",
        text: "Сканер в этом режиме не смотрит эфир, поэтому ленты подсказок нет.",
      },
    ];
  }

  if (id === "esp32") {
    return [
      {
        key: "synth",
        kicker: "ESP32",
        title: "Синтезатор",
        text: "ESP32 ведёт ADF4351 по коридору. Антенны скана нет.",
      },
      {
        key: "grid",
        kicker: "Сетка",
        title: "Шаг коридора",
        text: `Рисунок шагает по ${band} — та же полоса, что у снимка. Спектр здесь не крутится.`,
      },
      {
        key: "usb",
        kicker: "Связь",
        title: "USB в боевом контуре",
        text: "Боевой коридор идёт по USB. Этот рисунок по USB не пишет.",
      },
    ];
  }

  return [
    {
      key: "map",
      kicker: "Позиция",
      title: "Карта",
      text: "Позиция отвечает, дойдёт ли сигнал по пути. Это карта, не спектр.",
    },
    {
      key: "tape",
      kicker: "Снимок",
      title: "Лента сюда не входит",
      text: "Запись Signal Hound в этой сцене не играет. Сканер остаётся в режиме «Атака».",
    },
    {
      key: "calc",
      kicker: "Рельеф",
      title: "Расчёт боевого контура",
      text: "Рельеф и расчёт пути отсюда не вызываются. На рисунке только схема двух точек.",
    },
  ];
}
