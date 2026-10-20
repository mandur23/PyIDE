import os
import unittest


class EnvTest(unittest.TestCase):
    def test_sees_dotenv(self):
        self.assertEqual(os.environ.get("FOO"), "foo-from-dotenv-7f3a")
