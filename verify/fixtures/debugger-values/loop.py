def run(limit):
    data = {'k': 1}
    note = {'text': 'ab' * 200}
    total = 0
    for i in range(limit):
        total += i
    return total, data['k'], len(note['text'])


label = 'sum'
print(f'{label}={run(5)}')
