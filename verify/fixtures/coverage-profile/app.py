"""Fixture program for Run with Coverage and Profile."""
import time


def classify(n):
    if n < 0:
        return 'negative'
    if n == 0:
        return 'zero'
    return 'positive'


def unused():
    value = 21
    return value * 2


def slow_sum(n):
    total = 0
    for i in range(n):
        total += i
    return total


def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


def busy_wait(seconds):
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        pass


def compute():
    return slow_sum(20000) + fib(15)


def main():
    print(classify(5), classify(0))
    print('compute:', compute())
    busy_wait(0.3)


if __name__ == '__main__':
    main()
