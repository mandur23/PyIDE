import geo.shapes
from geo import shapes
from geo.shapes import area
from geo.report import report
from tools.calc import double_area
import scripts.extra


def main():
    print(geo.shapes.area(2), shapes.area(3), area(4), report(), double_area(5), scripts.extra.run())


if __name__ == '__main__':
    main()
