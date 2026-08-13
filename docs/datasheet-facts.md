# ADF4351 — выжимка фактов из даташита (Rev. A) с цитатами карт регистров

Первичный источник: [ADF4351 Datasheet (analog.com)](https://www.analog.com/media/en/technical-documentation/data-sheets/adf4351.pdf)
(текст даташита использован при проектировании; здесь — наша дистилляция для
локальной работы без сети). Сверено с эталоном `third_party/pyadf435x/core.py`.

## Ключевые параметры

| Параметр | Значение | Комментарий |
|---|---|---|
| Выходной диапазон | 35–4400 МГц | VCO 2200–4400 + делители 1/2/4/8/16/32/64 → мин. 34.375 МГц |
| Управление | 6 регистров × 32 бита, 3-wire (CLK/DATA/LE), MSB first, защёлка по фронту LE | Figure 2 |
| fPFD max | 32 МГц (frac-N) / 90 МГц (int-N) | |
| MOD | 2–4095 (12 бит) | FRAC < MOD |
| INT | 16 бит; min 23 (прескалер 4/5) / 75 (8/9) | Figure 24 |
| Прескалер | 4/5 до 3.6 ГГц; 8/9 выше | |
| Band select | 80 мкс; **20 мкс** при R3.DB23=1 (BS clock ≤ 500 кГц, делитель ≤ 254) | «Band selection takes 10 cycles of the PFD frequency» |
| Мощность | −4/−1/+2/+5 дБм (R4.DB[4:3]) | |
| MTLD | R4.DB10 — гашение выхода до захвата | |
| MUXOUT | R2.DB[28:26]: 0=three-state, 1=DVdd, 2=DGND, 3=R counter, 4=N divider, 5=analog LD, 6=digital LD | Figure 26 |
| LD pin mode | R5.DB[23:22]: 01 = digital lock detect | |

## Карты регистров (Figure 23, Register Summary — цитата-раскладка по битам)

```
R0: DB31=0 | INT[30:15] (16 бит) | FRAC[14:3] (12 бит) | C=000
R1: DB[31:29]=0 | PHADJ[28] | PRESC[27] | PHASE[26:15] (12 бит, реком. 1) | MOD[14:3] | C=001
R2: DB31=0 | LNSPUR[30:29] | MUXOUT[28:26] | DBLR[25] | RDIV2[24] | R[23:14] (10 бит)
    | DBB[13] | CP[12:9] (Icp) | LDF[8] | LDP[7] | PDPOL[6] | PD[5] | CP3S[4] | CRST[3] | C=010
R3: DB[31:24]=0 | BSCMODE[23] | ABP[22] | CHGCANCEL[21] | DB[20:19]=0 | CSR[18]
    | CLKDIVMODE[16:15] | CLKDIV[14:3] (12 бит) | C=011
R4: DB[31:24]=0 | FBSEL[23] | RFDIV[22:20] | BSDIV[19:12] (8 бит) | VCOPD[11] | MTLD[10]
    | AUXSEL[9] | AUXEN[8] | AUXPWR[7:6] | RFEN[5] | PWR[4:3] | C=100
R5: DB[31:24]=0 | LDPIN[23:22] | DB21=0, DB20=1, DB19=1 | DB[18:3]=0 | C=101
    → при LDPIN=01: R5 = 0x00580005
```

## Правила записи (Program Modes)

1. **Порядок R5→R4→R3→R2→R1→R0.** R0 всегда последним.
2. Double-buffered поля (phase, MOD, doubler, div2, R counter, CP current)
   применяются только после записи R0.
3. Запись R0 триггерит VCO band select.

## Режимные биты (int-N vs frac-N)

| Бит | frac-N (FRAC≠0) | int-N (FRAC=0) | Источник |
|---|---|---|---|
| LDF (R2.DB8) | 0 (40 PFD циклов) | 1 (5 циклов) | «recommended DB8=0 for fractional-N and 1 for integer-N» |
| LDP (R2.DB7) | 0 (10 нс) | 1 (6 нс) | Figure: «U5 LDP: 0 10ns, 1 6ns» |
| ABP (R3.DB22) | 0 (6 нс) | 1 (3 нс) | «DB22=0 → 6 ns frac; DB22=1 → 3 ns int» |
| CHGCANCEL (R3.DB21) | 0 | 1 (снижает PFD-spurs) | |

## Формула

```
fPFD = fREF × (1 + D) / (R × (1 + T))
RFout = fPFD × (INT + FRAC/MOD) / RFDIV
```

Пример (наш модуль, fREF=25 МГц, R=1, D=T=0): fPFD=25 МГц.
2475 МГц → N=99 ровно → INT=99, FRAC=0, MOD=2 — чистый int-N.
Коридор 2400–2500 МГц: INT 96–100, перестройка = R1+R0.

## Тайминги перестройки (для dwell)

band select 20 мкс (fast mode) + settling петли ~100–300 мкс (фильтр типовых
модулей 30–35 кГц) → **0.15–0.5 мс**; dwell ≥ 1 мс — безопасный минимум.
