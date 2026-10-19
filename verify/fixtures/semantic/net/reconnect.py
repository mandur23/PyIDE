import asyncio
import random


async def connect_with_backoff(url, open_socket, max_delay=30.0):
    """Reconnect to the websocket server, waiting longer after each failed attempt."""
    delay = 0.5
    while True:
        try:
            return await open_socket(url)
        except OSError:
            await asyncio.sleep(delay + random.random() / 10)
            delay = min(max_delay, delay * 2)
