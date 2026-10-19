import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def main():
    df = pd.DataFrame({"id": np.arange(5000), "value": np.linspace(0, 1, 5000), "city": ["Seoul", "Busan"] * 2500})
    arr = np.arange(24, dtype=float).reshape(2, 3, 4)
    records = [{"name": "a", "n": 1}, {"name": "b", "n": None}]
    plt.figure("Debug plot")
    plt.plot(df["value"][:100])
    plt.show()
    print("stop here", len(df), arr.shape, len(records))
    return df


main()
