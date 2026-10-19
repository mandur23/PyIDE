import sys
import os
x=1
def f( a,b ):
    return a+b
y = [1,2]
print(os.getcwd(), sys.argv, x, f(1,2), y)
