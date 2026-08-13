// ============================================================================
// LEGION — cmd_server: реализация. Неблокирующий посимвольный приём из UART
// (poll) + канал-независимая обработка строк (processLine — для WS, фаза 4).
// Ответы: OK ... / ERR <code> ... / JSON. Протокол: docs/protocol.md.
// ============================================================================
#include "cmd_server.h"

#include <stdlib.h>
#include <string.h>

#include <math.h>  // isfinite — защита от NaN/inf (ревизия п.8)

#include "leveling.h"
#include "net_server.h"
#include "selftest.h"
#include "serial_sync.h"
#include "storage.h"
#include "sweep_engine.h"
#include "synth.h"

namespace legion {

// strtod("NaN")/("inf") проходят молча → NaN пробивает все сравнения.
// Единая проверка конечности для всех числовых аргументов (ревизия п.8).
static bool parse_finite(const char* s, double& out) {
  out = strtod(s, nullptr);
  return isfinite(out) != 0;
}

PlanStatus apply_frequency(AppState& s, uint64_t freq_hz, bool& lock) {
  // Ручная установка во время коридора = остановка коридора (политика)
  if (corridor_active()) {
    corridor_stop();
  }
  SynthPlan plan;
  const PlanStatus st = synth_apply(freq_hz, true, lock, &plan);
  if (st != PlanStatus::OK) {
    return st;
  }
  s.plan = plan;
  s.plan_valid = true;
  s.freq_hz = freq_hz;
  leveling_apply(freq_hz);      // выравнивание уровня (если включено)
  storage_save_freq(freq_hz);  // NVS-автономность (паттерн joseluu)
  return PlanStatus::OK;
}

void CmdServer::begin(AppState& state, Stream& port) {
  _s = &state;
  _port = &port;
  _len = 0;
}

void CmdServer::poll() {
  while (_port->available() > 0) {
    const char c = (char)_port->read();
    if (c == '\r') {
      continue;
    }
    if (c == '\n') {
      _buf[_len] = '\0';
      if (_len > 0) {
        processLine(_buf, *_port);
      }
      _len = 0;
      continue;
    }
    if (_len < sizeof(_buf) - 1) {
      _buf[_len++] = c;
    } else {
      _len = 0;  // переполнение — сброс строки
      _port->println(F("ERR SYNTAX line too long"));
    }
  }
}

void CmdServer::processLine(char* line, Print& out) {
  // Вывод ответа под мьютексом UART: иначе строки перемешиваются с
  // телеметрией telem_task посреди кадра (найдено при ревизии гонок, п.1).
  const bool is_uart = (&out == _port);
  if (is_uart) {
    serial_lock();
  }
  handleLine(line, out);
  if (is_uart) {
    serial_unlock();
  }
}

void CmdServer::handleLine(char* line, Print& out) {
  char* save = nullptr;
  char* tok = strtok_r(line, " ", &save);
  if (!tok) {
    return;
  }
  char* rest = strtok_r(nullptr, "", &save);  // остаток строки после команды
  if (rest) {
    while (*rest == ' ') ++rest;
  }

  if (strcasecmp(tok, "HELLO") == 0) {
    out.print(F("OK LEGION "));
    out.print(LEGION_VERSION);
    out.print(' ');
    out.println(LEGION_BUILD_BOARD);
  } else if (strcasecmp(tok, "SET") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    char* arg = strtok_r(nullptr, "", &save2);
    if (arg) {
      while (*arg == ' ') ++arg;
    }
    if (sub && strcasecmp(sub, "FREQ") == 0) {
      cmdSetFreq(arg, out);
    } else if (sub && strcasecmp(sub, "POWER") == 0) {
      cmdSetPower(arg, out);
    } else if (sub && strcasecmp(sub, "ATT") == 0) {
      cmdSetAtt(arg, out);
    } else if (sub && strcasecmp(sub, "LEVEL") == 0) {
      cmdSetLevel(arg, out);
    } else {
      out.println(F("ERR SYNTAX unknown SET"));
    }
  } else if (strcasecmp(tok, "RF") == 0 && rest) {
    cmdRf(rest, out);
  } else if (strcasecmp(tok, "SWEEP") == 0 && rest) {
    cmdCorridor(rest, CorridorMode::SWEEP, out);
  } else if (strcasecmp(tok, "HOP") == 0 && rest) {
    cmdCorridor(rest, CorridorMode::HOP, out);
  } else if (strcasecmp(tok, "CHIRP") == 0 && rest) {
    cmdCorridor(rest, CorridorMode::CHIRP, out);
  } else if (strcasecmp(tok, "GLIDE") == 0 && rest) {
    cmdGlide(rest, out);
  } else if (strcasecmp(tok, "FM") == 0 && rest) {
    cmdFm(rest, out);
  } else if (strcasecmp(tok, "STOP") == 0) {
    corridor_stop();
    storage_save_corridor(false, corridor_config());
    out.println(F("OK IDLE"));
  } else if (strcasecmp(tok, "WIFI") == 0 && rest) {
    cmdWifi(rest, out);
  } else if (strcasecmp(tok, "STATUS?") == 0) {
    cmdStatus(out);
  } else if (strcasecmp(tok, "LEVEL?") == 0) {
    cmdLevelStatus(out);
  } else if (strcasecmp(tok, "REGS?") == 0) {
    cmdRegs(out);
  } else if (strcasecmp(tok, "REGS") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    if (sub && strcasecmp(sub, "DIFF") == 0) {
      cmdRegsDiff(strtok_r(nullptr, "", &save2), out);
    } else {
      out.println(F("ERR SYNTAX REGS DIFF <r0..r5 hex>"));
    }
  } else if (strcasecmp(tok, "SELFTEST") == 0) {
    cmdSelftest(out);
  } else if (strcasecmp(tok, "CAL") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    char* arg = strtok_r(nullptr, "", &save2);
    if (arg) {
      while (*arg == ' ') ++arg;
    }
    if (sub && strcasecmp(sub, "REF") == 0 && arg) {
      cmdCalRef(arg, out);
    } else if (sub && strcasecmp(sub, "LEVEL") == 0) {
      cmdCalLevel(arg, out);
    } else {
      out.println(F("ERR SYNTAX unknown CAL"));
    }
  } else {
    out.print(F("ERR SYNTAX unknown command: "));
    out.println(tok);
  }
}

void CmdServer::cmdSetFreq(char* arg, Print& out) {
  if (!arg) {
    out.println(F("ERR SYNTAX freq required"));
    return;
  }
  double mhz;
  if (!parse_finite(arg, mhz) || mhz <= 0.0) {  // NaN/inf отсекаем
    out.println(F("ERR SYNTAX bad freq"));
    return;
  }
  const uint64_t hz = (uint64_t)(mhz * 1e6 + 0.5);
  bool lock = false;
  const PlanStatus st = apply_frequency(*_s, hz, lock);
  if (st == PlanStatus::ERR_RANGE) {
    out.println(F("ERR RANGE 35-4400 MHz"));
    return;
  }
  if (st != PlanStatus::OK) {
    out.print(F("ERR PLAN "));
    out.println((int)st);
    return;
  }
  out.print(F("OK FREQ="));
  out.print(mhz, 6);
  out.print(F(" LOCK="));
  out.print(lock ? 1 : 0);
  out.print(F(" ERR_HZ="));
  out.println(_s->plan.error_hz, 1);
}

void CmdServer::cmdSetPower(char* arg, Print& out) {
  if (!arg) {
    out.println(F("ERR SYNTAX power required"));
    return;
  }
  const int dbm = atoi(arg);
  uint8_t code;
  switch (dbm) {
    case -4: code = 0; break;
    case -1: code = 1; break;
    case 2: code = 2; break;
    case 5: code = 3; break;
    default:
      out.println(F("ERR RANGE power -4|-1|+2|+5"));
      return;
  }
  _s->cfg.output_power_code = code;
  storage_save_power(code);
  if (_s->plan_valid) {  // переписать план с новой мощностью
    bool lock;
    synth_apply(_s->freq_hz, true, lock, &_s->plan);
  }
  out.print(F("OK POWER="));
  out.println(dbm);
}

void CmdServer::cmdRf(char* arg, Print& out) {
  const bool on = (strcasecmp(arg, "ON") == 0);
  if (!on && strcasecmp(arg, "OFF") != 0) {
    out.println(F("ERR SYNTAX RF ON|OFF"));
    return;
  }
  _s->rf_on = on;
  _s->cfg.rf_output_enable = on;
  _s->drv->setChipEnable(on);
  storage_save_rf(on);
  if (_s->plan_valid) {
    bool lock;
    synth_apply(_s->freq_hz, true, lock, &_s->plan);
  }
  out.print(F("OK RF "));
  out.println(on ? F("ON") : F("OFF"));
}

// SWEEP START <f1> <f2> STEP <kHz> DWELL <ms> | SWEEP STOP
// HOP   START <f1> <f2> RATE <ms> [SEED <n>] [STEP <kHz>] | HOP STOP
// CHIRP START <f1> <f2> STEP <Hz> DWELL <ms> | CHIRP STOP  (шаг в Гц!)
void CmdServer::cmdCorridor(char* arg, CorridorMode mode, Print& out) {
  char* save = nullptr;
  char* sub = strtok_r(arg, " ", &save);
  if (!sub) {
    out.println(F("ERR SYNTAX START|STOP expected"));
    return;
  }
  if (strcasecmp(sub, "STOP") == 0) {
    corridor_stop();
    storage_save_corridor(false, corridor_config());
    out.println(F("OK IDLE"));
    return;
  }
  if (strcasecmp(sub, "START") != 0) {
    out.println(F("ERR SYNTAX START|STOP expected"));
    return;
  }

  CorridorConfig cfg;
  cfg.mode = mode;
  cfg.f1_hz = 0;
  cfg.f2_hz = 0;

  char* f1s = strtok_r(nullptr, " ", &save);
  char* f2s = strtok_r(nullptr, " ", &save);
  if (!f1s || !f2s) {
    out.println(F("ERR SYNTAX f1 f2 required"));
    return;
  }
  double f1d, f2d;
  if (!parse_finite(f1s, f1d) || !parse_finite(f2s, f2d)) {
    out.println(F("ERR SYNTAX bad f1/f2"));
    return;
  }
  cfg.f1_hz = (uint64_t)(f1d * 1e6 + 0.5);
  cfg.f2_hz = (uint64_t)(f2d * 1e6 + 0.5);
  cfg.dwell_ms = 10;  // дефолт (практика joseluu: 10 мс стабильно, E4)
  // Шаг: SWEEP/HOP — в кГц (обратная совместимость), CHIRP — в Гц
  cfg.step_hz = (mode == CorridorMode::CHIRP) ? 100000 : 1000000;
  cfg.seed = 1;

  char* kv = nullptr;
  while ((kv = strtok_r(nullptr, " ", &save)) != nullptr) {
    char* val = strtok_r(nullptr, " ", &save);
    if (!val) {
      break;
    }
    if (strcasecmp(kv, "STEP") == 0) {
      const uint32_t v = (uint32_t)strtoul(val, nullptr, 10);
      cfg.step_hz = (mode == CorridorMode::CHIRP) ? v : v * 1000UL;
    } else if (strcasecmp(kv, "DWELL") == 0 || strcasecmp(kv, "RATE") == 0) {
      cfg.dwell_ms = (uint32_t)strtoul(val, nullptr, 10);
    } else if (strcasecmp(kv, "SEED") == 0) {
      cfg.seed = (uint32_t)strtoul(val, nullptr, 10);
    }
  }

  char err[64];
  if (!corridor_start(cfg, err, sizeof(err))) {
    out.println(err);
    return;
  }
  storage_save_corridor(true, cfg);  // автономный рестарт (паттерн joseluu)
  out.print(F("OK "));
  out.print(mode == CorridorMode::SWEEP
                ? F("SWEEP")
                : mode == CorridorMode::HOP ? F("HOP") : F("CHIRP"));
  out.println(F(" RUNNING"));
}

// GLIDE <targetMHz> <durationMs> — плавный одноразовый переход (Electro-resonance)
void CmdServer::cmdGlide(char* arg, Print& out) {
  char* save = nullptr;
  char* tg = strtok_r(arg, " ", &save);
  char* du = strtok_r(nullptr, " ", &save);
  if (!tg || !du) {
    out.println(F("ERR SYNTAX GLIDE <targetMHz> <durationMs>"));
    return;
  }
  double tgd;
  if (!parse_finite(tg, tgd)) {
    out.println(F("ERR SYNTAX bad target"));
    return;
  }
  CorridorConfig cfg;
  cfg.mode = CorridorMode::GLIDE;
  cfg.f1_hz = corridor_active() ? corridor_current_hz() : _s->freq_hz;
  cfg.f2_hz = (uint64_t)(tgd * 1e6 + 0.5);
  cfg.dwell_ms = (uint32_t)strtoul(du, nullptr, 10);

  char err[64];
  if (!corridor_start(cfg, err, sizeof(err))) {
    out.println(err);
    return;
  }
  out.print(F("OK GLIDE RUNNING "));
  out.print(cfg.f1_hz / 1e6, 6);
  out.print(F(" -> "));
  out.println(cfg.f2_hz / 1e6, 6);
}

// FM START <SIN|TRI|RAND> CENTER <MHz> DEPTH <kHz> RATE <ms> | FM STOP
void CmdServer::cmdFm(char* arg, Print& out) {
  char* save = nullptr;
  char* sub = strtok_r(arg, " ", &save);
  if (!sub) {
    out.println(F("ERR SYNTAX FM START|STOP"));
    return;
  }
  if (strcasecmp(sub, "STOP") == 0) {
    corridor_stop();
    storage_save_corridor(false, corridor_config());
    out.println(F("OK IDLE"));
    return;
  }
  if (strcasecmp(sub, "START") != 0) {
    out.println(F("ERR SYNTAX FM START|STOP"));
    return;
  }
  char* shape = strtok_r(nullptr, " ", &save);
  CorridorMode mode = CorridorMode::FM_SIN;
  if (shape && strcasecmp(shape, "TRI") == 0) {
    mode = CorridorMode::FM_TRI;
  } else if (shape && strcasecmp(shape, "RAND") == 0) {
    mode = CorridorMode::FM_RAND;
  }

  CorridorConfig cfg;
  cfg.mode = mode;
  cfg.f1_hz = _s->freq_hz;  // центр = текущая частота по умолчанию
  cfg.fm_depth_hz = 100000.0;  // 100 кГц
  cfg.dwell_ms = 100;          // период LFO 100 мс
  cfg.seed = 1;

  char* kv = nullptr;
  while ((kv = strtok_r(nullptr, " ", &save)) != nullptr) {
    char* val = strtok_r(nullptr, " ", &save);
    if (!val) {
      break;
    }
    if (strcasecmp(kv, "CENTER") == 0) {
      double v;
      if (parse_finite(val, v)) cfg.f1_hz = (uint64_t)(v * 1e6 + 0.5);
    } else if (strcasecmp(kv, "DEPTH") == 0) {
      double v;
      if (parse_finite(val, v)) cfg.fm_depth_hz = v * 1000.0;  // кГц → Гц
    } else if (strcasecmp(kv, "RATE") == 0) {
      cfg.dwell_ms = (uint32_t)strtoul(val, nullptr, 10);
    } else if (strcasecmp(kv, "SEED") == 0) {
      cfg.seed = (uint32_t)strtoul(val, nullptr, 10);
    }
  }

  char err[64];
  if (!corridor_start(cfg, err, sizeof(err))) {
    out.println(err);
    return;
  }
  out.print(F("OK FM RUNNING "));
  out.println(shape ? shape : "SIN");
}

void CmdServer::cmdStatus(Print& out) {
  out.print(F("{\"freq\":"));
  out.print(_s->freq_hz / 1e6, 6);
  out.print(F(",\"mode\":\""));
  if (corridor_active()) {
    // Все режимы по имени (было: только SWEEP/HOP — CHIRP/GLIDE/FM
    // ошибочно показывались как HOP; найдено при ревизии, п.8)
    out.print(corridor_mode_name(corridor_mode()));
  } else {
    out.print(F("MANUAL"));
  }
  out.print(F("\",\"lock\":"));
  out.print(_s->drv->readLock() ? 1 : 0);
  out.print(F(",\"rf\":"));
  out.print(_s->rf_on ? 1 : 0);
  out.print(F(",\"power\":"));
  out.print((int)_s->cfg.output_power_code);
  out.print(F(",\"version\":\""));
  out.print(LEGION_VERSION);
  out.print(F("\",\"board\":\""));
  out.print(LEGION_BUILD_BOARD);
  out.println(F("\"}"));
}

void CmdServer::cmdRegs(Print& out) {
  out.print(F("{\"regs\":["));
  for (int i = 0; i < 6; ++i) {
    char hex[12];
    snprintf(hex, sizeof(hex), "\"0x%08lX\"",
             (unsigned long)(_s->plan_valid ? _s->plan.regs[i] : 0));
    out.print(hex);
    if (i < 5) {
      out.print(',');
    }
  }
  out.println(F("}"));
}

// REGS DIFF <r0> <r1> <r2> <r3> <r4> <r5> (hex) — сравнение с текущим планом.
// Идея Wei1234c/Signal_Generators: diff регистров — главный инструмент отладки
// драйвера (несовпадающие поля видны мгновенно).
void CmdServer::cmdRegsDiff(char* arg, Print& out) {
  if (!arg) {
    out.println(F("ERR SYNTAX regs diff needs 6 hex words"));
    return;
  }
  uint32_t theirs[6];
  char* save = nullptr;
  for (int i = 0; i < 6; ++i) {
    char* w = strtok_r(nullptr, " ", &save);
    if (!w) {
      out.println(F("ERR SYNTAX regs diff needs 6 hex words"));
      return;
    }
    theirs[i] = (uint32_t)strtoul(w, nullptr, 16);
  }
  out.print(F("{\"diff\":["));
  for (int i = 0; i < 6; ++i) {
    const uint32_t mine = _s->plan_valid ? _s->plan.regs[i] : 0;
    const uint32_t d = mine ^ theirs[i];
    char hex[16];
    snprintf(hex, sizeof(hex), "{\"r\":%d,\"xor\":\"0x%08lX\"}", i,
             (unsigned long)d);
    out.print(hex);
    if (i < 5) {
      out.print(',');
    }
  }
  out.println(F("]}"));
}

void CmdServer::cmdCalRef(char* arg, Print& out) {
  double ppm;
  if (!parse_finite(arg, ppm)) {
    out.println(F("ERR SYNTAX bad ppm"));
    return;
  }
  _s->cfg.ref_ppm_milli = (int32_t)(ppm * 1000.0);
  storage_save_ppm(_s->cfg.ref_ppm_milli);
  out.print(F("OK CAL REF "));
  out.print(ppm, 3);
  out.println(F(" ppm"));
}

void CmdServer::cmdSelftest(Print& out) { selftest_run(*_s, out); }

// SET ATT <dB> — PE43702, 0–31.75 дБ шаг 0.25 (фаза 8).
// Ручная установка затухания — это override: выключаем авто-выравнивание,
// иначе следующий шаг коридора/частоты перезапишет затухание (фаза 10).
void CmdServer::cmdSetAtt(char* arg, Print& out) {
  if (!arg || !_s->att) {
    out.println(F("ERR SYNTAX att required"));
    return;
  }
  double dbd;
  if (!parse_finite(arg, dbd)) {
    out.println(F("ERR SYNTAX bad att"));
    return;
  }
  const float db = (float)dbd;
  if (db < 0.0f || db > 31.75f) {
    out.println(F("ERR RANGE att 0-31.75"));
    return;
  }
  if (leveling_enabled()) {
    leveling_disable();
    persistLevel();
  }
  const float actual = _s->att->setDb(db);
  storage_save_att(actual);
  out.print(F("OK ATT="));
  out.print(actual, 2);
  out.println(F(" dB"));
}

// SET LEVEL <dBm> | OFF — включить/выключить авто-выравнивание уровня.
// Требует калибровки (CAL LEVEL ...). Цель обязана быть не выше минимума
// измеренного по полосе — аттенюатор только ослабляет (leveling_math.h).
void CmdServer::cmdSetLevel(char* arg, Print& out) {
  if (!arg) {
    out.println(F("ERR SYNTAX SET LEVEL <dBm>|OFF"));
    return;
  }
  if (strcasecmp(arg, "OFF") == 0) {
    leveling_disable();
    persistLevel();
    out.println(F("OK LEVEL OFF"));
    return;
  }
  double dbm;
  if (!parse_finite(arg, dbm)) {
    out.println(F("ERR SYNTAX bad level dBm"));
    return;
  }
  leveling_set_target(dbm);
  persistLevel();
  // Применить немедленно к текущей частоте (коридор — со следующего шага сам)
  const uint64_t f = corridor_active() ? corridor_current_hz() : _s->freq_hz;
  const double att = leveling_apply(f);
  out.print(F("OK LEVEL="));
  out.print(dbm, 2);
  if (att >= 0.0) {
    out.print(F(" ATT="));
    out.print(att, 2);
    out.println(F(" dB"));
  } else {
    out.println(F(" (no cal — add points via CAL LEVEL)"));
  }
}

// CAL LEVEL <freqMHz> <dBm> — добавить/заменить точку калибровки.
// CAL LEVEL CLEAR — очистить таблицу.
void CmdServer::cmdCalLevel(char* arg, Print& out) {
  if (!arg) {
    out.println(F("ERR SYNTAX CAL LEVEL <freqMHz> <dBm>|CLEAR"));
    return;
  }
  char* save = nullptr;
  char* a = strtok_r(arg, " ", &save);
  if (a && strcasecmp(a, "CLEAR") == 0) {
    leveling_clear();
    persistLevel();
    out.println(F("OK CAL LEVEL CLEAR n=0"));
    return;
  }
  char* b = strtok_r(nullptr, " ", &save);
  double fmhz, dbm;
  if (!a || !b || !parse_finite(a, fmhz) || !parse_finite(b, dbm) ||
      fmhz <= 0.0) {
    out.println(F("ERR SYNTAX CAL LEVEL <freqMHz> <dBm>|CLEAR"));
    return;
  }
  if (!leveling_add_point(fmhz, dbm)) {
    out.println(F("ERR RANGE level table full"));
    return;
  }
  persistLevel();
  out.print(F("OK CAL LEVEL "));
  out.print(fmhz, 3);
  out.print(' ');
  out.print(dbm, 2);
  out.print(F(" n="));
  out.println(leveling_count());
}

// LEVEL? — JSON: {enabled, target, points:[[fMHz,dBm],...]}
void CmdServer::cmdLevelStatus(Print& out) {
  out.print(F("{\"enabled\":"));
  out.print(leveling_enabled() ? 1 : 0);
  out.print(F(",\"target\":"));
  out.print(leveling_target(), 2);
  out.print(F(",\"points\":["));
  const LevelPoint* t = leveling_table();
  const int n = leveling_count();
  for (int i = 0; i < n; ++i) {
    char buf[48];
    snprintf(buf, sizeof(buf), "[%.3f,%.2f]", t[i].freq_mhz, t[i].dbm);
    out.print(buf);
    if (i < n - 1) {
      out.print(',');
    }
  }
  out.println(F("]}"));
}

void CmdServer::persistLevel() {
  storage_save_level(leveling_table(), leveling_count(), leveling_enabled(),
                     leveling_target());
}

void CmdServer::cmdWifi(char* arg, Print& out) { net_wifi_cmd(*_s, arg, out); }

}  // namespace legion
