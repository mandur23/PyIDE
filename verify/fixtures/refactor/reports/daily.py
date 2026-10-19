from shop import pricing
from shop.formatting import money


def summary(cart):
    lines = [money(pricing.net_price(p, q)) for p, q in cart.items]
    return ", ".join(lines)
