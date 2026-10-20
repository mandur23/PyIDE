# Reads the orders export that the DuckDB console queries.
import csv

with open("data/orders.csv", newline="") as f:
    print(sum(float(r["amount"]) for r in csv.DictReader(f)))
