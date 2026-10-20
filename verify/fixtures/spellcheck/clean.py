"""Utilities for reading configuration files."""
import json
import os

# 설정 파일을 읽어서 사전으로 돌려준다
# Read the settings file and return a dictionary.
DEFAULT_PATH = "~/.config/app/settings.json"  # see https://example.com/docs?id=0x1f
BUFFER_SIZE = 0xFFAA


class ConfigReader:
    """Reads JSON settings from disk.

    Contact admin@example.com when the format changes.
    """

    def __init__(self, path=DEFAULT_PATH):
        self.path = os.path.expanduser(path)

    def load_settings(self, *args, **kwargs):
        # 한글 주석은 검사하지 않는다
        with open(self.path, encoding="utf-8") as stream:
            return json.load(stream)


def parse_http_header(raw_value):
    """Split an HTTP header value at semicolons."""
    return [part.strip() for part in raw_value.split(";")]
