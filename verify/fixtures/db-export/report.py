import sqlite3


def load(path):
    return sqlite3.connect(path).execute("SELECT * FROM items").fetchall()
