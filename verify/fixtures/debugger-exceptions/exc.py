from errors import AppError


def parse(text):
    if not text:
        raise ValueError('empty text')
    return int(text)


def check(n):
    if n > 2:
        raise AppError(f'too big: {n}')
    return n


try:
    parse('')
except ValueError as e:
    print(f'caught {e}')
for n in range(5):
    try:
        check(n)
    except AppError as e:
        print(f'caught {e}')
print('done')
