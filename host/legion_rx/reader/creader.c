/* legion_creader — C-читатель FIFO для лабораторного приёма I/Q (шаг 3.8).
 *
 * Читает ровно len(buffer) байт из fd (FIFO /tmp/iq, bladeRF-cli rx
 * format=bin, SC16_Q11 int16 LE I-first) прямо в память numpy-массива
 * через buffer protocol. Никакого Python f.read: read(2) в цикле,
 * частичные чтения FIFO собираются до полного кадра.
 *
 * Метки времени (шаг 4.7): CLOCK_MONOTONIC — тот же клок, что
 * time.per_counter() в CPython. t_first — сразу после первого вернувшего
 * данные read() кадра (момент прихода данных в userspace), t_done —
 * после последнего байта. НС, int64.
 *
 * Сборка: python3 -m legion_rx.reader.build  (gcc -shared -fPIC).
 */
#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>

static int64_t mono_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
}

/* read_exact(fd, buffer, blocking=True) -> (n_read, t_first_ns, t_done_ns)
 * buffer — любой writable объект buffer protocol (numpy int16/uint8...).
 * EOF (писатель закрыл FIFO): n_read < len, повторный вызов даст 0.
 * GIL отпускаем на время read(): стрим 80 МБ/с не душит GPU-поток. */
static PyObject *py_read_exact(PyObject *self, PyObject *args, PyObject *kw) {
    int fd;
    Py_buffer view;
    int blocking = 1;
    static char *kwlist[] = {"fd", "buffer", "blocking", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, kw, "iw*|p", kwlist,
                                     &fd, &view, &blocking)) {
        return NULL;
    }

    char *p = (char *)view.buf;
    Py_ssize_t left = view.len;
    Py_ssize_t total = 0;
    int64_t t_first = 0, t_done = 0;
    int flags = 0;
    int read_errno = 0;  /* 0 = штатный EOF/пусто; иначе errno ошибки */

    if (!blocking) {
        flags = fcntl(fd, F_GETFL, 0);
        if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    Py_BEGIN_ALLOW_THREADS
    while (left > 0) {
        ssize_t n = read(fd, p, (size_t)left);
        if (n > 0) {
            if (t_first == 0) t_first = mono_ns();
            p += n;
            left -= n;
            total += n;
        } else if (n == 0) {
            break; /* EOF: писатель FIFO закрылся */
        } else if (errno == EINTR) {
            continue;
        } else if (!blocking && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            break;
        } else {
            read_errno = errno;
            break;
        }
    }
    if (t_first != 0) t_done = mono_ns();
    Py_END_ALLOW_THREADS

    if (!blocking && flags >= 0) fcntl(fd, F_SETFL, flags);

    if (read_errno) {
        errno = read_errno;
        PyErr_SetFromErrno(PyExc_OSError);
        PyBuffer_Release(&view);
        return NULL;
    }
    PyBuffer_Release(&view);
    return Py_BuildValue("(nLL)", total,
                         (long long)t_first, (long long)t_done);
}

static PyObject *py_mono_ns(PyObject *self, PyObject *noargs) {
    return PyLong_FromLongLong((long long)mono_ns());
}

static PyMethodDef Methods[] = {
    {"read_exact", (PyCFunction)py_read_exact, METH_VARARGS | METH_KEYWORDS,
     "read_exact(fd, buffer, blocking=True) -> (n, t_first_ns, t_done_ns)\n"
     "Дочитывает ровно len(buffer) байт из fd. Метки CLOCK_MONOTONIC, нс."},
    {"mono_ns", py_mono_ns, METH_NOARGS,
     "CLOCK_MONOTONIC в нс — тот же клок, что time.perf_counter()."},
    {NULL, NULL, 0, NULL},
};

static struct PyModuleDef moduledef = {
    PyModuleDef_HEAD_INIT, "legion_creader",
    "C-читатель FIFO лабораторного приёма I/Q (bladeRF SC16_Q11).",
    -1, Methods,
};

PyMODINIT_FUNC PyInit_legion_creader(void) {
    return PyModule_Create(&moduledef);
}
