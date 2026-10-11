"""Разбор ответов bladeRF-cli (шаги 3.7, 3.9): терпимый парсер rx status."""
from legion_rx.cli_session import _fmt_hz, parse_rx_status


def test_parse_status_colon_form():
    st = parse_rx_status("RX:   State: Running\n      Overruns: 0\n      Underruns: 3\n")
    assert st["overruns"] == 0
    assert st["underruns"] == 3
    assert st["state"] == "running"


def test_parse_status_count_first_form():
    st = parse_rx_status("RX stream: 12 overruns, 0 underruns")
    assert st["overruns"] == 12


def test_parse_status_unknown_format_is_none_not_zero():
    """Нет поля в формате — None и сырой текст, а не выдуманный ноль."""
    st = parse_rx_status("RX: enabled, streaming")
    assert st["overruns"] is None
    assert "enabled" in st["raw"]


def test_fmt_hz():
    assert _fmt_hz(2400e6) == "2400M"
    assert _fmt_hz(868e6) == "868M"
    assert _fmt_hz(20e6) == "20M"
    assert _fmt_hz(15e3) == "15K"
    assert _fmt_hz(1234) == "1234"
