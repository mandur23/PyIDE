import argparse

parser = argparse.ArgumentParser(description="Demo app package")
parser.add_argument("--name", default="world", help="who to greet")
parser.add_argument("-v", "--verbose", action="store_true")
args = parser.parse_args()
print(f"Hello from app, {args.name}")
