# Area of a few rectangles
def area(w, h):
    return w * h


sizes = [2, 3, 4]
total = 0
for s in sizes:
    total += area(s, s)
print("total", total)
if total > 20:
    print("big")
