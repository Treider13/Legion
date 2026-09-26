"""Bias-T defaults only: run with python -m unittest discover -s tools -p test_bias_tee.py."""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "fpga" / "host"))
import sdr_worker as worker
import legion_gateway as gateway
import legion_fpga as protocol


class SoapyBiasTeeTests(unittest.TestCase):
    def device(self, hardware="bladerf2"):
        dev = Mock()
        dev.getHardwareKey.return_value = hardware
        dev.getHardwareInfo.return_value = {}
        dev.listAntennas.return_value = []
        dev.getGainRange.return_value = types.SimpleNamespace(
            minimum=lambda: 0, maximum=lambda: 50)
        return dev

    def test_both_supplies_off_before_frontend_for_rx_and_tx(self):
        for can_tx in (False, True):
            with self.subTest(can_tx=can_tx):
                dev = self.device()
                worker._setup_front_end(dev, can_tx)
                self.assertEqual(dev.writeSetting.call_args_list,
                                 [unittest.mock.call("biastee_rx", "false"),
                                  unittest.mock.call("biastee_tx", "false")])
                names = [call[0] for call in dev.method_calls]
                self.assertLess(max(i for i, name in enumerate(names)
                                    if name == "writeSetting"), names.index("listAntennas"))
                dev.readSetting.assert_not_called()

    def test_other_radios_receive_no_bias_settings(self):
        for hardware in ("bladerf1", "lime", "", "ad9361"):
            with self.subTest(hardware=hardware):
                dev = self.device(hardware)
                worker._setup_front_end(dev, False)
                dev.writeSetting.assert_not_called()

    def test_both_disables_attempted_and_failure_blocks_frontend(self):
        for failing in ("biastee_rx", "biastee_tx"):
            with self.subTest(failing=failing):
                dev = self.device()
                def write(key, value):
                    if key == failing:
                        raise RuntimeError("injected driver failure")
                dev.writeSetting.side_effect = write
                with self.assertRaisesRegex(RuntimeError, "Bias-T OFF"):
                    worker._setup_front_end(dev, False)
                self.assertEqual(dev.writeSetting.call_count, 2)
                dev.listAntennas.assert_not_called()

    def test_open_fails_when_driver_cannot_disable_bias(self):
        dev = self.device()
        dev.writeSetting.side_effect = RuntimeError("injected driver failure")
        soapy = types.SimpleNamespace(Device=Mock(return_value=dev))
        with patch.object(worker, "SOAPY", True), patch.object(worker, "NUMPY", True), \
                patch.object(worker, "SoapySDR", soapy, create=True), \
                patch.object(worker.time, "sleep"), patch.object(worker.gc, "collect"):
            radio = worker.Radio()
            radio.fake = False
            result = radio.open("driver=bladerf", 20.0, False, False)
        self.assertFalse(result["ok"])
        self.assertIn("Bias-T OFF", result["reason"])
        self.assertIsNone(radio.dev)


class UsbError(Exception):
    pass


class UsbDevice:
    def __init__(self, value=0xA5A58421):
        self.value = value
        self.configured = 1
        self.requests = []
        self.disposed = 0
        self.fail_request = None
        self.bad_response = None
        self.ignore_write = False
        self.reenumerate = False

    def get_active_configuration(self):
        return 1

    def ctrl_transfer(self, *args, **kwargs):
        return self.configured.to_bytes(4, "little")

    def write(self, ep, request, timeout=None):
        if self.reenumerate and request[1] != 0x03:
            self.reenumerate = False
            self.value |= 0x420
            raise UsbError("re-enumerated")
        self.requests.append(bytes(request))
        if len(self.requests) == self.fail_request:
            raise UsbError("injected I/O failure")
        if request[1] == 0x03 and request[2] & 1 and not self.ignore_write:
            self.value = int.from_bytes(request[5:9], "little")

    def read(self, ep, length, timeout=None):
        if self.bad_response is not None:
            return self.bad_response
        response = bytearray(self.requests[-1])
        response[2] |= protocol.NIOS_PKT_8x32_FLAG_SUCCESS
        response[5:9] = self.value.to_bytes(4, "little")
        return bytes(response)


class UsbBiasTeeTests(unittest.TestCase):
    def usb_modules(self, dev, board="bladerf2"):
        usb = types.ModuleType("usb")
        usb.core = types.ModuleType("usb.core")
        usb.util = types.ModuleType("usb.util")
        usb.core.USBError = UsbError
        usb.core.find = lambda **kw: dev if gateway.BLADERF_PIDS[kw["idProduct"]] == board else None
        usb.util.dispose_resources = lambda d: setattr(d, "disposed", d.disposed + 1)
        return {"usb": usb, "usb.core": usb.core, "usb.util": usb.util}

    def test_acquire_clears_only_bias_bits_for_all_initial_states(self):
        for flags in (0, 0x20, 0x400, 0x420):
            with self.subTest(flags=flags):
                original = (0xA5A5FFFF & ~0x420) | flags
                dev = UsbDevice(original)
                with patch.dict(sys.modules, self.usb_modules(dev)):
                    gateway.UsbTransport()
                self.assertEqual(dev.value, original & ~0x420)
                self.assertEqual([(r[1], r[2] & 1, r[4]) for r in dev.requests],
                                 [(3, 0, 0), (3, 1, 0), (3, 0, 0)])

    def test_release_acquire_disables_previously_enabled_supplies(self):
        dev = UsbDevice()
        with patch.dict(sys.modules, self.usb_modules(dev)):
            transport = gateway.UsbTransport()
            transport.release()
            dev.value |= 0x420
            transport.acquire()
        self.assertEqual(dev.value & 0x420, 0)
        self.assertEqual(len(dev.requests), 6)

    def test_usb_recovery_disables_before_retrying_original_request(self):
        dev = UsbDevice()
        with patch.dict(sys.modules, self.usb_modules(dev)), patch.object(gateway.time, "sleep"):
            transport = gateway.UsbTransport()
            dev.reenumerate = True
            request = protocol.pack_8x32(protocol.LEGION_TARGET, False, 0, 0)
            transport.xfer(request)
        self.assertEqual(dev.value & 0x420, 0)
        self.assertEqual([r[1] for r in dev.requests], [3, 3, 3, 3, 3, 3, 0x80])

    def test_fpga_load_disables_after_image_is_ready(self):
        dev = UsbDevice()
        dev.configured = 0
        def load(transport):
            self.assertEqual(dev.requests, [])
            dev.configured = 1
            dev.value |= 0x420
        with patch.dict(sys.modules, self.usb_modules(dev)), patch.object(gateway.time, "sleep"), \
                patch.object(gateway.UsbTransport, "_load_fpga", load):
            gateway.UsbTransport()
        self.assertEqual(dev.value & 0x420, 0)

    def test_bladerf1_has_no_additional_register_access(self):
        dev = UsbDevice()
        original = dev.value
        with patch.dict(sys.modules, self.usb_modules(dev, "bladerf1")):
            gateway.UsbTransport()
        self.assertEqual(dev.value, original)
        self.assertEqual(dev.requests, [])

    def test_each_io_failure_aborts_without_recursive_reacquire(self):
        for failing in (1, 2, 3):
            with self.subTest(failing=failing):
                dev = UsbDevice()
                dev.fail_request = failing
                transport = gateway.UsbTransport.__new__(gateway.UsbTransport)
                with patch.dict(sys.modules, self.usb_modules(dev)):
                    with self.assertRaises(UsbError):
                        transport.__init__()
                self.assertIsNone(transport._dev)
                self.assertEqual(len(dev.requests), failing)

    def test_invalid_or_rejected_response_aborts(self):
        good = bytearray(protocol.pack_8x32(3, False, 0, 0))
        good[2] |= protocol.NIOS_PKT_8x32_FLAG_SUCCESS
        wrong_target = bytearray(good)
        wrong_target[1] = 1
        wrong_address = bytearray(good)
        wrong_address[4] = 1
        for response in (b"", bytes(16), protocol.pack_8x32(3, False, 0, 0),
                         bytes(wrong_target), bytes(wrong_address)):
            with self.subTest(response=response):
                dev = UsbDevice()
                dev.bad_response = response
                with patch.dict(sys.modules, self.usb_modules(dev)):
                    with self.assertRaisesRegex(RuntimeError, "Bias-T OFF"):
                        gateway.UsbTransport()

    def test_acknowledged_but_ineffective_write_fails_readback(self):
        dev = UsbDevice(0x420)
        dev.ignore_write = True
        with patch.dict(sys.modules, self.usb_modules(dev)):
            with self.assertRaisesRegex(RuntimeError, "Bias-T OFF"):
                gateway.UsbTransport()
        self.assertEqual(len(dev.requests), 3)


class TxGainTests(unittest.TestCase):
    def device(self):
        dev = Mock()
        dev.getHardwareKey.return_value = "bladerf2"
        dev.getHardwareInfo.return_value = {}
        dev.listAntennas.return_value = []
        dev.getGainRange.return_value = types.SimpleNamespace(
            minimum=lambda: 0, maximum=lambda: 50)
        dev.getGain.side_effect = RuntimeError("no readback")
        return dev

    def tx_sets(self, dev):
        return [c.args[2] for c in dev.setGain.call_args_list
                if c.args and c.args[0] == worker.SOAPY_SDR_TX]

    def test_default_is_forty_percent_of_range(self):
        dev = self.device()
        info = worker._setup_front_end(dev, True)
        self.assertEqual(self.tx_sets(dev), [20.0])
        self.assertEqual(info["txGainDb"], 20.0)
        self.assertEqual((info["txGainMin"], info["txGainMax"]), (0.0, 50.0))

    def test_requested_gain_is_clamped(self):
        high = self.device()
        self.assertEqual(worker._setup_front_end(high, True, 80)["txGainDb"], 50.0)
        self.assertEqual(self.tx_sets(high), [50.0])
        low = self.device()
        self.assertEqual(worker._setup_front_end(low, True, -5)["txGainDb"], 0.0)
        self.assertEqual(self.tx_sets(low), [0.0])

    def test_rx_only_does_not_set_tx_gain(self):
        dev = self.device()
        self.assertIsNone(worker._setup_front_end(dev, False, 30))
        self.assertEqual(self.tx_sets(dev), [])

    def test_fake_radio_remembers_operator_gain(self):
        radio = worker.Radio()
        radio.fake = True
        result = radio.set_tx_gain(33)
        self.assertTrue(result["ok"])
        self.assertEqual(radio.tx_gain_db, 33.0)
        self.assertFalse(radio.set_tx_gain(float("nan"))["ok"])


if __name__ == "__main__":
    unittest.main()
