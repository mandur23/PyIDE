total = 0
for i in range(6):
    total += i
    print(f"step {i}")
hits = 0
for k in range(5):
    hits += 1
print("done", total, hits)
