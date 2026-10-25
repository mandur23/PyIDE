from shapes import Square


def main(items):
    total = compute_total(items)
    sq = Square(2)
    print(sq.perimeter(), total)
    print("Area of %s is %.1f" % (sq, scale))
    return Report(total)


main([1, 2])
