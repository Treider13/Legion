// ============================================================================
// LEGION — cmd_server: реализация. Неблокирующий посимвольный приём из UART
// (poll) + канал-независимая обработка строк (processLine — для WS, фаза 4).
// Ответы: OK ... / ERR <code> ... / JSON. Протокол: docs/protocol.md.
// ============================================================================
#include "cmd_server.h"

#include <stdlib.h>
#include <string.h>

#include "net_server.h"
#include "selftest.h"
#include "storage.h"
#include "sweep_engine.h"
#include "synth.h"

namespace legion {

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

void CmdServer::processLine(char* line, Print& out) { handleLine(line, out); }

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
    } else {
      out.println(F("ERR SYNTAX unknown SET"));
    }
  } else if (strcasecmp(tok, "RF") == 0 && rest) {
    cmdRf(rest, out);
  } else if (strcasecmp(tok, "SWEEP") == 0 && rest) {
    cmdCorridor(rest, CorridorMode::SWEEP, out);
  } else if (strcasecmp(tok, "HOP") == 0 && rest) {
    cmdCorridor(rest, CorridorMode::HOP, out);
  } else if (strcasecmp(tok, "STOP") == 0) {
    corridor_stop();
    storage_save_corridor(false, corridor_config());
    out.println(F("OK IDLE"));
  } else if (strcasecmp(tok, "WIFI") == 0 && rest) {
    cmdWifi(rest, out);
  } else if (strcasecmp(tok, "STATUS?") == 0) {
    cmdStatus(out);
  } else if (strcasecmp(tok, "REGS?") == 0) {
    cmdRegs(out);
  } else if (strcasecmp(tok, "SELFTEST") == 0) {
    cmdSelftest(out);
  } else if (strcasecmp(tok, "CAL") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    char* arg = strtok_r(nullptr, "", &save2);
    if (sub && strcasecmp(sub, "REF") == 0 && arg) {
      cmdCalRef(arg, out);
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
  const double mhz = strtod(arg, nullptr);
  if (mhz <= 0.0) {
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
  cfg.f1_hz = (uint64_t)(strtod(f1s, nullptr) * 1e6 + 0.5);
  cfg.f2_hz = (uint64_t)(strtod(f2s, nullptr) * 1e6 + 0.5);
  cfg.dwell_ms = 10;    // дефолт (практика joseluu: 10 мс стабильно, E4)
  cfg.step_khz = 1000;  // дефолт 1 МГц
  cfg.seed = 1;

  char* kv = nullptr;
  while ((kv = strtok_r(nullptr, " ", &save)) != nullptr) {
    char* val = strtok_r(nullptr, " ", &save);
    if (!val) {
      break;
    }
    if (strcasecmp(kv, "STEP") == 0) {
      cfg.step_khz = (uint32_t)strtoul(val, nullptr, 10);
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
  out.print(mode == CorridorMode::SWEEP ? F("SWEEP") : F("HOP"));
  out.println(F(" RUNNING"));
}

void CmdServer::cmdStatus(Print& out) {
  out.print(F("{\"freq\":"));
  out.print(_s->freq_hz / 1e6, 6);
  out.print(F(",\"mode\":\""));
  if (corridor_active()) {
    out.print(corridor_mode() == CorridorMode::SWEEP ? F("SWEEP") : F("HOP"));
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

void CmdServer::cmdCalRef(char* arg, Print& out) {
  const double ppm = strtod(arg, nullptr);
  _s->cfg.ref_ppm_milli = (int32_t)(ppm * 1000.0);
  storage_save_ppm(_s->cfg.ref_ppm_milli);
  out.print(F("OK CAL REF "));
  out.print(ppm, 3);
  out.println(F(" ppm"));
}

void CmdServer::cmdSelftest(Print& out) { selftest_run(*_s, out); }

void CmdServer::cmdWifi(char* arg, Print& out) { net_wifi_cmd(*_s, arg, out); }

}  // namespace legion
