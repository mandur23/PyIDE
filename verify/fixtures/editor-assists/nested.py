import functools


def deco(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


class Outer:
    """Outer docstring."""

    class Inner:
        @deco
        @staticmethod
        def method(
            first,
            second,
        ) -> int:
            total = first + second
            total += 0
            total += 1
            total += 2
            total += 3
            total += 4
            total += 5
            total += 6
            total += 7
            total += 8
            total += 9
            total += 10
            total += 11
            total += 12
            total += 13
            total += 14
            total += 15
            total += 16
            total += 17
            total += 18
            total += 19
            total += 20
            total += 21
            total += 22
            total += 23
            total += 24
            total += 25
            total += 26
            total += 27
            total += 28
            total += 29
            total += 30
            total += 31
            total += 32
            total += 33
            total += 34
            total += 35
            total += 36
            total += 37
            total += 38
            total += 39
            total += 40
            total += 41
            total += 42
            total += 43
            total += 44
            total += 45
            total += 46
            total += 47
            total += 48
            total += 49
            total += 50
            total += 51
            total += 52
            total += 53
            total += 54
            total += 55
            total += 56
            total += 57
            total += 58
            total += 59
            return total

    def after(self):
        return 1


VALUE_0 = 0
VALUE_1 = 1
VALUE_2 = 2
VALUE_3 = 3
VALUE_4 = 4
VALUE_5 = 5
VALUE_6 = 6
VALUE_7 = 7
VALUE_8 = 8
VALUE_9 = 9
VALUE_10 = 10
VALUE_11 = 11
VALUE_12 = 12
VALUE_13 = 13
VALUE_14 = 14
VALUE_15 = 15
VALUE_16 = 16
VALUE_17 = 17
VALUE_18 = 18
VALUE_19 = 19
VALUE_20 = 20
VALUE_21 = 21
VALUE_22 = 22
VALUE_23 = 23
VALUE_24 = 24
VALUE_25 = 25
VALUE_26 = 26
VALUE_27 = 27
VALUE_28 = 28
VALUE_29 = 29
VALUE_30 = 30
VALUE_31 = 31
VALUE_32 = 32
VALUE_33 = 33
VALUE_34 = 34
VALUE_35 = 35
VALUE_36 = 36
VALUE_37 = 37
VALUE_38 = 38
VALUE_39 = 39
