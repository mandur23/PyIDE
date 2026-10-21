import time


def tick(counter):
    counter += 1
    if counter % 5 == 0:
        print(f"tick {counter}", flush=True)
    return counter


def main():
    counter = 0
    while True:
        counter = tick(counter)
        time.sleep(0.2)


if __name__ == "__main__":
    main()
