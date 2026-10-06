import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'sign_ohos', Path(__file__).resolve().parents[1] / 'scripts/sign-ohos-release.py')
signer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signer)


class ReleaseSigningTests(unittest.TestCase):
    def test_rejects_debug_profiles_even_when_bundle_matches(self):
        with self.assertRaises(ValueError):
            signer.validate_identity({'type': 'debug', 'bundle-info': {'bundle-name': 'app'}},
                                     {'app': {'bundleName': 'app'}})

    def test_rejects_wrong_or_missing_package_identity(self):
        profile = {'type': 'release', 'bundle-info': {'bundle-name': 'app'}}
        for manifest in [{}, {'app': {'bundleName': 'other'}}]:
            with self.assertRaises(ValueError):
                signer.validate_identity(profile, manifest)
        signer.validate_identity(profile, {'app': {'bundleName': 'app'}})

    def test_sdk_failures_do_not_expose_arguments_or_output(self):
        with patch.object(signer.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, b'password-from-sdk', b'password-from-sdk')):
            with self.assertRaises(ValueError) as error:
                signer.run(['java', '-keyPwd', 'password-from-argv'])
        self.assertNotIn('password', str(error.exception))


if __name__ == '__main__':
    unittest.main()
