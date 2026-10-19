import sqlite3


def count_users(path):
    with sqlite3.connect(path) as db:
        return db.execute("SELECT count(*) FROM users").fetchone()[0]
