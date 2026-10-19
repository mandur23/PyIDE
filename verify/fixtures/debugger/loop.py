import time

count = 0
for i in range(1200):
    count += 1
    time.sleep(0.05)
print("loop done", count)
