import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('oksana_shell',Path(__file__).resolve().parents[1]/'deploy/oksana-shell.py')
shell=importlib.util.module_from_spec(spec);spec.loader.exec_module(shell)


class OksanaIsolationTests(unittest.TestCase):
    def run_command(self, command):
        with patch.object(shell.sys,'argv',['nasa-space-apps-shell']), \
             patch.object(shell.Path,'read_text',return_value=json.dumps({'uid':1008,'gid':1008})), \
             patch.dict(shell.os.environ,{'SSH_ORIGINAL_COMMAND':command}), \
             patch.object(shell.sys.stdin,'isatty',return_value=False), \
             patch.object(shell.subprocess,'call',return_value=0) as execute:
            with self.assertRaises(SystemExit) as result:shell.main()
            self.assertEqual(result.exception.code,0)
            return execute.call_args.args[0]

    def test_client_command_remains_an_argument_inside_unprivileged_container(self):
        hostile='$(touch /tmp/host-escape); cat /root/platforms/secrets'
        args=self.run_command(hostile)
        self.assertEqual(args[0],'/usr/bin/docker')
        self.assertEqual(args[args.index('--user')+1],'1008:1008')
        self.assertEqual(args[-4:],['nasa-space-apps-oksana','/bin/bash','-c',hostile])

    def test_sftp_runs_inside_container(self):
        args=self.run_command('/usr/lib/openssh/sftp-server')
        self.assertEqual(args[-4:],['nasa-space-apps-oksana','/usr/lib/openssh/sftp-server','-d','/workspace'])

    def test_wrapper_rejects_additional_host_arguments(self):
        with patch.object(shell.sys,'argv',['nasa-space-apps-shell','/bin/bash']), \
             patch.object(shell.subprocess,'call') as execute:
            with self.assertRaises(SystemExit):shell.main()
            execute.assert_not_called()


if __name__=='__main__':unittest.main()
