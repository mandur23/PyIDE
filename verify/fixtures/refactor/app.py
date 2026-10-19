from shop.pricing import Cart, net_price, receipt, rounded
from reports.daily import summary


def main():
    cart = Cart("ana")
    cart.add(10.0, 3)
    cart.add(2.5)
    print(rounded(net_price(4.0, 5)))
    receipt(12.0, 2)
    print(summary(cart))
    print(rounded(cart.value()))


if __name__ == "__main__":
    main()
