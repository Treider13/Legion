// ============================================================================
// LEGION — фаззинг РЕАЛЬНОГО парсера прошивки (cmd_server.cpp, production
// код), собранного на хосте с минимальными shim'ами (test/shims/Arduino.h).
// Инварианты: парсер никогда не падает; ответ всегда OK/ERR/JSON/пусто;
// после фаззинга валидные команды работают.
// ============================================================================
#include <unity.h>

#include <cstdint>
#include <cstdlib>
#include <string>

// --- Реальный тестируемый код ---
#include "cmd_server.h"

// ============================================================================
// Тестовые двойники зависимостей (парсер — под тестом, железо — нет)
// ============================================================================
namespace legion {

// --- Драйвер ADF4351 (объявления из adf4351.h) ---
static bool g_lock_state = true;
void Adf4351Driver::begin() {}
void Adf4351Driver::writePlan(const SynthPlan&) {}
void Adf4351Driver::writeRegister(uint32_t) {}
bool Adf4351Driver::readLock() { return g_lock_state; }
void Adf4351Driver::setChipEnable(bool) {}

// --- Аттенюатор ---
static float g_att_db = 0.0f;
void Attenuator::begin() {}
float Attenuator::setDb(float db) { g_att_db = db; return db; }

// --- synth ---
static Adf4351Driver g_drv;
void synth_init(Adf4351Driver&, PlannerConfig&) {}
PlanStatus synth_apply(uint64_t freq_hz, bool, bool& lock, SynthPlan* out) {
  lock = g_lock_state;
  if (out) {
    PlannerConfig cfg;
    return plan_frequency(freq_hz, cfg, *out);  // реальный планировщик!
  }
  PlannerConfig cfg;
  SynthPlan tmp;
  return plan_frequency(freq_hz, cfg, tmp);
}
Adf4351Driver& synth_driver() { return g_drv; }

// --- corridor ---
static bool g_corr_active = false;
static CorridorConfig g_corr_cfg;
void corridor_init(Adf4351Driver&, PlannerConfig&, Stream&) {}
bool corridor_start(const CorridorConfig& cfg, char* err, size_t n) {
  if (cfg.f1_hz < ADF_FREQ_MIN_HZ || cfg.f2_hz > ADF_FREQ_MAX_HZ ||
      (cfg.mode <= CorridorMode::CHIRP && cfg.f1_hz >= cfg.f2_hz)) {
    snprintf(err, n, "ERR RANGE corridor");
    return false;
  }
  if (cfg.dwell_ms < 1) {
    snprintf(err, n, "ERR DWELL min 1 ms");
    return false;
  }
  g_corr_active = true;
  g_corr_cfg = cfg;
  return true;
}
void corridor_stop() { g_corr_active = false; }
bool corridor_active() { return g_corr_active; }
CorridorMode corridor_mode() { return g_corr_cfg.mode; }
uint64_t corridor_current_hz() { return 2400000000ULL; }
const CorridorConfig& corridor_config() { return g_corr_cfg; }

// --- storage (no-op) ---
void storage_save_freq(uint64_t) {}
void storage_save_power(uint8_t) {}
void storage_save_rf(bool) {}
void storage_save_ppm(int32_t) {}
void storage_save_att(float) {}
void storage_save_corridor(bool, const CorridorConfig&) {}

// --- net / selftest ---
void net_wifi_cmd(AppState&, char*, Print& out) { out.println("{\"wifi\":{}}"); }
void selftest_run(AppState&, Print& out) {
  out.println("{\"selftest\":{\"pass\":1}}");
}

}  // namespace legion

// ============================================================================
// Фазз-драйвер
// ============================================================================
using namespace legion;

static AppState g_state;
static CmdServer g_cmd;
static Stream g_uart;

// xorshift32 — тот же, что в прошивке (воспроизводимость по seed)
static uint32_t s_state = 0x12345678;
static uint32_t rnd() {
  s_state ^= s_state << 13;
  s_state ^= s_state >> 17;
  s_state ^= s_state << 5;
  return s_state;
}

static const char* TOKENS[] = {
    "SET FREQ", "SET POWER", "SET ATT", "RF ON", "RF OFF", "STATUS?",
    "REGS?", "SELFTEST", "HELLO", "STOP", "SWEEP START", "HOP START",
    "CHIRP START", "GLIDE", "FM START", "CAL REF", "WIFI STATUS?",
    "SWEEP STOP", "HOP STOP", "FM STOP",
};

static std::string fuzz_case() {
  const uint32_t kind = rnd() % 7;
  std::string s;
  switch (kind) {
    case 0: {  // валидная команда + случайные аргументы
      s = TOKENS[rnd() % (sizeof(TOKENS) / sizeof(TOKENS[0]))];
      const int nargs = rnd() % 4;
      for (int i = 0; i < nargs; ++i) {
        s += ' ';
        const int len = rnd() % 8;
        for (int j = 0; j < len; ++j) s += (char)(32 + rnd() % 95);
      }
      break;
    }
    case 1: {  // чистый мусор
      const int len = 1 + rnd() % 40;
      for (int j = 0; j < len; ++j) s += (char)(32 + rnd() % 95);
      break;
    }
    case 2:  // переполнение буфера (160)
      s = "SET FREQ ";
      s.append(100 + rnd() % 200, '9');
      break;
    case 3: {  // граничные числа
      static const char* vals[] = {"-1", "0", "34.375", "4400", "4400.0001",
                                   "1e12", "NaN", "inf", "0x10", ""};
      s = TOKENS[rnd() % 6];
      s += ' ';
      s += vals[rnd() % 10];
      break;
    }
    case 4: {  // усечённая команда
      s = TOKENS[rnd() % (sizeof(TOKENS) / sizeof(TOKENS[0]))];
      s = s.substr(0, 1 + rnd() % 3);
      break;
    }
    case 5:  // эталонная валидная
      s = (const char*[]){"HELLO", "STATUS?", "SET FREQ 2475.000", "STOP"}[rnd() % 4];
      break;
    default:  // управляющие/не-ASCII байты
      const int len = 1 + rnd() % 20;
      for (int j = 0; j < len; ++j) s += (char)(1 + rnd() % 255);
      break;
  }
  return s;
}

static bool response_ok(const std::string& resp) {
  if (resp.empty()) return true;  // пусто — допустимо (мусорная строка)
  return resp.rfind("OK", 0) == 0 || resp.rfind("ERR", 0) == 0 ||
         resp.rfind("{", 0) == 0;
}

void test_fuzz_parser_10k() {
  g_state.drv = &g_drv;
  Attenuator att;
  g_state.att = &att;
  g_cmd.begin(g_state, g_uart);

  uint32_t bad = 0;
  for (int i = 0; i < 10000; ++i) {
    std::string line = fuzz_case();
    g_uart.clear();
    // processLine требует mutable char*
    char buf[512];
    snprintf(buf, sizeof(buf), "%s", line.c_str());
    g_cmd.processLine(buf, g_uart);  // крах здесь = падение теста
    if (!response_ok(g_uart.buf)) {
      bad++;
      printf("BAD RESP @%d: out=%s\n", i, g_uart.buf.c_str());
    }
  }
  TEST_ASSERT_EQUAL_UINT32(0, bad);

  // Живость после фаззинга. ВАЖНО: strtok_r пишет во входной буфер —
  // строковые литералы (.rodata) копируем в стек (иначе SIGSEGV — найдено gdb).
  char alive1[32], alive2[32], alive3[32];
  strcpy(alive1, "HELLO");
  strcpy(alive2, "SET FREQ 2475.000");
  strcpy(alive3, "STATUS?");

  g_uart.clear();
  g_cmd.processLine(alive1, g_uart);
  TEST_ASSERT(g_uart.buf.rfind("OK LEGION", 0) == 0);

  g_uart.clear();
  g_cmd.processLine(alive2, g_uart);
  TEST_ASSERT(g_uart.buf.find("OK FREQ=2475.000000") != std::string::npos);

  g_uart.clear();
  g_cmd.processLine(alive3, g_uart);
  TEST_ASSERT(g_uart.buf.rfind("{", 0) == 0);
}

int main(int argc, char** argv) {
  (void)argc; (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_fuzz_parser_10k);
  return UNITY_END();
}
