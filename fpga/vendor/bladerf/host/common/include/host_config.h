/**
 * NIOS-сборка libad936x не запускает host/CMakeLists.txt, который из
 * host_config.h.in пишет host/build/common/include/host_config.h.
 * Полный Linux-заголовок тянет glibc <endian.h> и <pwd.h> — в nios2-elf
 * (newlib) их нет. Макросы те же, что cmakedefine01 на Linux little-endian:
 * патч 0006 включает <malloc.h> только если BLADERF_OS_FREEBSD не определён,
 * а cmakedefine01 определяет его как 0.
 */
#ifndef HOST_CONFIG_H__
#define HOST_CONFIG_H__

#define BLADERF_OS_LINUX 1
#define BLADERF_OS_FREEBSD 0
#define BLADERF_OS_OSX 0
#define BLADERF_OS_WINDOWS 0
#define BLADERF_BIG_ENDIAN 0

#ifndef ARRAY_SIZE
#define ARRAY_SIZE(n) (sizeof(n) / sizeof((n)[0]))
#endif

#ifndef FIELD_INIT
#define FIELD_INIT(field, ...) field = __VA_ARGS__
#endif

#ifndef EXPLICIT_FALLTHROUGH
#if defined(__GNUC__) && (__GNUC__ >= 7)
#define EXPLICIT_FALLTHROUGH __attribute__((fallthrough))
#else
#define EXPLICIT_FALLTHROUGH
#endif
#endif

#endif
