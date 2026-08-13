// ============================================================================
// LEGION — cmd_server: реализация. Неблокирующий посимвольный приём,
// команды завершаются '\n'. Ответы: OK ... / ERR <code> ... / JSON.
// ============================================================================
#include "cmd_server.h"

#include <stdlib.h>
#include <string.h>

#include "selftest.h"

namespace legion {

// Таймаут захвата: band select 20 мкс (F4) + settling ~0.1–0.3 мс (F5);
// опрашиваем до 50 мс, требуем 5 подряд HIGH (debounce, факт F12).
static constexpr uint32_t LOCK_TIMEOUT_MS = 50;
static constexpr uint8_t LOCK_DEBOUNCE = 5;

PlanStatus apply_frequency(AppState& s, uint64_t freq_hz, bool& lock) {
  SynthPlan plan;
  const PlanStatus st = plan_frequency(freq_hz, s.cfg, plan);
  if (st != PlanStatus::OK) {
    return st;
  }
  s.plan = plan;
  s.plan_valid = true;
  s.freq_hz = freq_hz;
  s.drv->writePlan(plan);

  lock = false;
  uint8_t streak = 0;
  const uint32_t t0 = millis();
  while (millis() - t0 < LOCK_TIMEOUT_MS) {
    if (s.drv->readLock()) {
      if (++streak >= LOCK_DEBOUNCE) {
        lock = true;
        break;
      }
    } else {
      streak = 0;
    }
    delay(1);
  }
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
        handleLine(_buf);
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

void CmdServer::handleLine(char* line) {
  // Разбор: COMMAND [ARGS...]
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
    _port->print(F("OK LEGION "));
    _port->print(LEGION_VERSION);
    _port->print(' ');
    _port->println(LEGION_BUILD_BOARD);
  } else if (strcasecmp(tok, "SET") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    char* arg = strtok_r(nullptr, "", &save2);
    if (arg) {
      while (*arg == ' ') ++arg;
    }
    if (sub && strcasecmp(sub, "FREQ") == 0) {
      cmdSetFreq(arg);
    } else if (sub && strcasecmp(sub, "POWER") == 0) {
      cmdSetPower(arg);
    } else {
      _port->println(F("ERR SYNTAX unknown SET"));
    }
  } else if (strcasecmp(tok, "RF") == 0 && rest) {
    cmdRf(rest);
  } else if (strcasecmp(tok, "STATUS?") == 0) {
    cmdStatus();
  } else if (strcasecmp(tok, "REGS?") == 0) {
    cmdRegs();
  } else if (strcasecmp(tok, "SELFTEST") == 0) {
    cmdSelftest();
  } else if (strcasecmp(tok, "CAL") == 0 && rest) {
    char* save2 = nullptr;
    char* sub = strtok_r(rest, " ", &save2);
    char* arg = strtok_r(nullptr, "", &save2);
    if (sub && strcasecmp(sub, "REF") == 0 && arg) {
      cmdCalRef(arg);
    } else {
      _port->println(F("ERR SYNTAX unknown CAL"));
    }
  } else {
    _port->print(F("ERR SYNTAX unknown command: "));
    _port->println(tok);
  }
}

void CmdServer::cmdSetFreq(char* arg) {
  if (!arg) {
    _port->println(F("ERR SYNTAX freq required"));
    return;
  }
  const double mhz = strtod(arg, nullptr);
  if (mhz <= 0.0) {
    _port->println(F("ERR SYNTAX bad freq"));
    return;
  }
  const uint64_t hz = (uint64_t)(mhz * 1e6 + 0.5);
  bool lock = false;
  const PlanStatus st = apply_frequency(*_s, hz, lock);
  if (st == PlanStatus::ERR_RANGE) {
    _port->println(F("ERR RANGE 35-4400 MHz"));
    return;
  }
  if (st != PlanStatus::OK) {
    _port->print(F("ERR PLAN "));
    _port->println((int)st);
    return;
  }
  _port->print(F("OK FREQ="));
  _port->print(mhz, 6);
  _port->print(F(" LOCK="));
  _port->print(lock ? 1 : 0);
  _port->print(F(" ERR_HZ="));
  _port->println(_s->plan.error_hz, 1);
}

void CmdServer::cmdSetPower(char* arg) {
  if (!arg) {
    _port->println(F("ERR SYNTAX power required"));
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
      _port->println(F("ERR RANGE power -4|-1|+2|+5"));
      return;
  }
  _s->cfg.output_power_code = code;
  if (_s->plan_valid) {  // переписать план с новой мощностью
    bool lock;
    apply_frequency(*_s, _s->freq_hz, lock);
  }
  _port->print(F("OK POWER="));
  _port->println(dbm);
}

void CmdServer::cmdRf(char* arg) {
  const bool on = (strcasecmp(arg, "ON") == 0);
  if (!on && strcasecmp(arg, "OFF") != 0) {
    _port->println(F("ERR SYNTAX RF ON|OFF"));
    return;
  }
  _s->rf_on = on;
  _s->cfg.rf_output_enable = on;
  _s->drv->setChipEnable(on);
  if (_s->plan_valid) {
    bool lock;
    apply_frequency(*_s, _s->freq_hz, lock);
  }
  _port->print(F("OK RF "));
  _port->println(on ? F("ON") : F("OFF"));
}

void CmdServer::cmdStatus() {
  _port->print(F("{\"freq\":"));
  _port->print(_s->freq_hz / 1e6, 6);
  _port->print(F(",\"mode\":\"MANUAL\",\"lock\":"));
  _port->print(_s->drv->readLock() ? 1 : 0);
  _port->print(F(",\"rf\":"));
  _port->print(_s->rf_on ? 1 : 0);
  _port->print(F(",\"power\":"));
  _port->print((int)_s->cfg.output_power_code);
  _port->print(F(",\"version\":\""));
  _port->print(LEGION_VERSION);
  _port->print(F("\",\"board\":\""));
  _port->print(LEGION_BUILD_BOARD);
  _port->println(F("\"}"));
}

void CmdServer::cmdRegs() {
  _port->print(F("{\"regs\":["));
  for (int i = 0; i < 6; ++i) {
    char hex[12];
    snprintf(hex, sizeof(hex), "\"0x%08lX\"",
             (unsigned long)(_s->plan_valid ? _s->plan.regs[i] : 0));
    _port->print(hex);
    if (i < 5) {
      _port->print(',');
    }
  }
  _port->println(F("}"));
}

void CmdServer::cmdCalRef(char* arg) {
  const double ppm = strtod(arg, nullptr);
  _s->cfg.ref_ppm_milli = (int32_t)(ppm * 1000.0);
  _port->print(F("OK CAL REF "));
  _port->print(ppm, 3);
  _port->println(F(" ppm"));
}

void CmdServer::cmdSelftest() { selftest_run(*_s, *_port); }

}  // namespace legion
