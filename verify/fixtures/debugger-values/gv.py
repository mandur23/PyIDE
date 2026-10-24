counter = 1


def bump():
    local = 2
    return local + counter


print('result', bump())
print('counter', counter)
