// ============================================================================
// LEGION — минимальный shim Arduino.h для host-сборки (только для тестов
// парсера на ПК; НЕ используется в прошивке). Покрывает то, что нужно
// cmd_server.cpp: Print/Stream/millis/delay/F.
// ============================================================================
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

// F() macro: на хосте — тождественность
#ifndef F
#define F(x) (x)
#endif

class Print {
 public:
  virtual ~Print() = default;
  virtual size_t write(uint8_t c) {
    buf += (char)c;
    return 1;
  }
  // println/print в стиле Arduino — минимум для cmd_server
  template <typename T>
  void print(T v) {
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "%s", toStr(v).c_str());
    for (const char* p = tmp; *p; ++p) write(*p);
  }
  template <typename T>
  void print(T v, int fmt) {  // double с точностью / int с базой
    char tmp[64];
    if constexpr (std::is_floating_point<T>::value) {
      snprintf(tmp, sizeof(tmp), "%.*f", fmt, (double)v);
    } else {
      snprintf(tmp, sizeof(tmp), "%ld", (long)v);
    }
    for (const char* p = tmp; *p; ++p) write(*p);
  }
  template <typename T>
  void println(T v) {
    print(v);
    write('\n');
  }
  template <typename T>
  void println(T v, int fmt) {
    print(v, fmt);
    write('\n');
  }
  void println() { write('\n'); }

  std::string buf;  // накопленный вывод (для проверок в тесте)
  void clear() { buf.clear(); }

 private:
  static std::string toStr(const char* s) { return s; }
  static std::string toStr(char* s) { return s; }
  static std::string toStr(int v) { return std::to_string(v); }
  static std::string toStr(unsigned v) { return std::to_string(v); }
  static std::string toStr(long v) { return std::to_string(v); }
  static std::string toStr(unsigned long v) { return std::to_string(v); }
  static std::string toStr(double v) {
    char t[32];
    snprintf(t, sizeof(t), "%.2f", v);
    return t;
  }
};

class Stream : public Print {
 public:
  int available() { return 0; }
  int read() { return -1; }
};

inline unsigned long millis() { return 0; }
inline void delay(unsigned long) {}
inline void ets_delay_us(uint32_t) {}

#define OUTPUT 1
#define INPUT 0
#define HIGH 1
#define LOW 0
inline void pinMode(int, int) {}
inline int digitalRead(int) { return 0; }
