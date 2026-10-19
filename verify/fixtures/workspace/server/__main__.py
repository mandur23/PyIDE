import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
args = parser.parse_args()
print("server would read", args.config)
