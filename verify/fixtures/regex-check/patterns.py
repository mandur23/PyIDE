import re

DATE = re.compile(r"(?P<year>\d{4})-(?P<month>\d\d)-(\d\d)")
WORDS = re.findall(r"\b\w+\b", "alpha beta", re.I)
CASE = re.search("hello", "HELLO world", flags=re.IGNORECASE | re.M)
BROKEN = re.compile(r"(abc[")
ESCAPED = re.match("\\d+\\s(\\w+)", "12 apples")
BAD_ESCAPED = re.compile("a\\d(")
KOREAN = re.findall(r"[가-힣]+", "안녕 세계 hello")
POSSESSIVE = re.fullmatch(r"a++b", "aaab")
VERBOSE = re.compile(r"""
    (\d+)    # number
    \s*
    ([a-z]+) # unit
""", re.X)
SPLIT = re.split(r"\s*,\s*", "a , b,c")
SLOW = re.match(r"(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab")
NOT_REGEX = print("(not a regex")
