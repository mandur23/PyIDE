import sys

print("TTY", sys.stdout.isatty(), sys.stdin.isatty())
print("\x1b[31mRED-TEXT\x1b[0m")
for i in range(3):
    print(f"\rPROGRESS {i}/2", end="", flush=True)
print()
name = input("Name: ")
print("Hello", name)
