"""Lifecycle safety without mutating launchd or opening real network connections."""
import errno
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import service_control as service

class ServiceControlTests(unittest.TestCase):
    def test_blocked_probe_prevents_stop_mutation(self):
        with patch.object(service,'probe',side_effect=RuntimeError('probe blocked')),patch.object(service,'command') as command:
            with self.assertRaises(RuntimeError): service.stop('gui/fictional')
            command.assert_not_called()

    def test_blocked_probe_prevents_start_mutation(self):
        with patch.object(service,'probe',side_effect=RuntimeError('probe blocked')),patch.object(service,'command') as command:
            with self.assertRaises(RuntimeError): service.start(Path('/fictional'), 'gui/fictional')
            command.assert_not_called()

    def test_stop_waits_for_old_job_process_and_port(self):
        responses=[subprocess.CompletedProcess([],0,'\tpid = 123\n'),
                   subprocess.CompletedProcess([],0,''),
                   subprocess.CompletedProcess([],0,''),
                   subprocess.CompletedProcess([],1,'')]
        with patch.object(service,'probe',return_value={'ready':True}),patch.object(service,'command',side_effect=responses),patch.object(service.os,'kill',side_effect=[None,ProcessLookupError()]),patch.object(service,'port_open',return_value=False),patch.object(service.time,'sleep') as wait:
            service.stop('gui/fictional')
            wait.assert_called_once()

    def test_port_permission_failure_is_not_reported_as_free(self):
        with patch.object(service.socket,'socket') as socket:
            socket.return_value.__enter__.return_value.connect_ex.return_value=errno.EPERM
            with self.assertRaises(RuntimeError): service.port_open()
