#!/bin/bash
# Иконка меню открывает основное приложение: спектр, водопад и настройки.
if [ -x /usr/bin/legion ]; then
  exec /usr/bin/legion
fi
echo "Нет /usr/bin/legion. Из каталога репозитория: ./tools/install_desktop.sh" >&2
exit 1
