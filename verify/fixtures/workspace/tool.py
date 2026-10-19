import argparse
import os


def main():
    parser = argparse.ArgumentParser(description="A small tool")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("target", nargs="?", default=".")
    args = parser.parse_args()
    for i in range(args.count):
        print(f"tool ran {i + 1}/{args.count} mode={os.environ.get('TOOL_MODE', 'plain')}")


if __name__ == "__main__":
    main()
