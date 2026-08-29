# LEGION — pytest: скриптовые наборы (свои раннеры check()/main, не
# pytest-стиль) при импорте прогонялись бы целиком на этапе сбора.
# Они завёрнуты в fpga/test/test_host_suites.py как subprocess-прогоны.
collect_ignore = [
    "tools/test_sdr_worker.py",
    "fpga/test/test_legion_fpga.py",
]
