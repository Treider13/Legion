"""Разбор ответов bladeRF-cli (шаги 3.7, 3.9): терпимый парсер rx status."""
from legion_rx.cli_session import (_fmt_hz, _rx_config_line, parse_rx_status,
                                   parse_usb_speed)


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


def test_rx_config_line_transfers16():
    """[F1] Nuand: buffers=32, num_transfers=16 для высоких samplerates."""
    line = _rx_config_line("/tmp/iq", "bin", 0, 32, 16, 10000)
    assert "buffers=32" in line
    assert "num_transfers=16" in line
    assert "format=bin" in line
    assert "file=/tmp/iq" in line


def test_parse_usb_speed():
    assert parse_usb_speed("  USB speed:                SuperSpeed\n") is True
    assert parse_usb_speed("  USB speed:                HighSpeed\n") is False
    assert parse_usb_speed("no usb info here") is None
    assert parse_usb_speed("backend usb 3.0 superspeed") is True
