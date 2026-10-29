"""Minecraft Java Edition Server List Ping, both sides (wiki.vg protocol: handshake, status, ping/pong).

  python mcping.py serve PORT          a stand-in server that answers the status ping with a fixed MOTD
  python mcping.py ping HOST PORT      what a client does for the multiplayer list: prints the JSON and the latency
"""
import json, socket, struct, sys, time

MOTD = 'PyIDE bore test server'


def varint(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def read_varint(sock):
    n = shift = 0
    while True:
        b = sock.recv(1)
        if not b:
            raise ConnectionError('closed')
        n |= (b[0] & 0x7F) << shift
        if not b[0] & 0x80:
            return n
        shift += 7


def packet(pid, body=b''):
    data = varint(pid) + body
    return varint(len(data)) + data


def read_packet(sock):
    length = read_varint(sock)
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ConnectionError('closed')
        data += chunk
    return data


def mc_string(s):
    b = s.encode()
    return varint(len(b)) + b


def serve(port):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', port))
    srv.listen(8)
    print(f'listening on 127.0.0.1:{port}', flush=True)
    status = json.dumps({'version': {'name': '1.20.1', 'protocol': 763}, 'players': {'max': 20, 'online': 0},
                         'description': {'text': MOTD}})
    import threading

    def handle(conn, addr):
        conn.settimeout(10)
        try:
            read_packet(conn)                      # handshake (next state 1 = status)
            read_packet(conn)                      # status request
            conn.sendall(packet(0, mc_string(status)))
            ping = read_packet(conn)               # ping with a long
            conn.sendall(packet(1, ping[1:]))
            print(f'status ping from {addr[0]}', flush=True)
        except Exception as e:
            print(f'connection from {addr[0]}: {e}', flush=True)
        finally:
            conn.close()

    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


def ping(host, port):
    t0 = time.time()
    with socket.create_connection((host, port), timeout=15) as s:
        s.settimeout(15)
        s.sendall(packet(0, varint(763) + mc_string(host) + struct.pack('>H', port) + varint(1)))
        s.sendall(packet(0))
        data = read_packet(s)
        n = 1  # skip the packet id 0
        length = 0
        shift = 0
        while True:
            b = data[n]; n += 1
            length |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        status = json.loads(data[n:n + length])
        sent = int(time.time() * 1000)
        s.sendall(packet(1, struct.pack('>q', sent)))
        pong = read_packet(s)
        assert struct.unpack('>q', pong[1:9])[0] == sent, 'pong mismatch'
    print(json.dumps({'motd': status['description']['text'], 'version': status['version']['name'],
                      'ms': round((time.time() - t0) * 1000)}))


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        serve(int(sys.argv[2]))
    else:
        ping(sys.argv[2], int(sys.argv[3]))
