"""Prices and discounts."""
import math


def net_price(price, quantity):
    subtotal = price * quantity
    return subtotal - subtotal * 0.1


def rounded(value):
    return math.floor(value * 100 + 0.5) / 100


def receipt(price, quantity):
    total = net_price(price, quantity)
    print("total", rounded(total))
    print("tax", rounded(total * 0.2))
    return total


class Cart:
    def __init__(self, owner):
        self.owner = owner
        self.items = []

    def add(self, price, quantity=1):
        self.items.append((price, quantity))

    def value(self):
        return sum(net_price(p, q) for p, q in self.items)
