import time

count = 0
print("loop started", flush=True)
for i in range(1200):
    count += 1
    time.sleep(0.05)
print("loop done", count)
