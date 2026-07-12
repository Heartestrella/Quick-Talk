"""
Quick UDP / QUIC reachability probe for the Quick Talk WebTransport endpoint.

Layers checked, in order:
  1. DNS resolution
  2. Raw UDP reachability  — send junk, listen for ANY response (a real QUIC
     server responds to junk with a Version Negotiation packet or ignores it,
     but middleboxes that block UDP entirely give ICMP unreachable or nothing)
  3. Real QUIC Initial packet — hand-crafted so it's routable through the
     server's UDP stack; a QUIC-capable server MUST respond within ~1 second
     (Version Negotiation or CRYPTO frames).  If we get nothing, either UDP
     is filtered somewhere OR the port isn't QUIC.

Run:
    python scripts/udp-check.py qt.13ee.icu 4433
"""
import socket
import struct
import sys
import time
import os

HOST = sys.argv[1] if len(sys.argv) > 1 else 'qt.13ee.icu'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4433


def step(msg):
    print(f'\n===  {msg}  ===')


# -------- 1. DNS --------
step('1) DNS resolution')
try:
    infos = socket.getaddrinfo(HOST, PORT, proto=socket.IPPROTO_UDP)
    ips = sorted({i[4][0] for i in infos})
    print(f'  {HOST} -> {", ".join(ips)}')
    ip = ips[0]
except Exception as e:
    print(f'  FAIL: {e}')
    sys.exit(1)


# -------- 2. Raw UDP reachability --------
step('2) Raw UDP: send 8 bytes, listen 2 s')
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(2.0)
try:
    sock.sendto(b'\x00' * 8, (ip, PORT))
    data, addr = sock.recvfrom(4096)
    print(f'  GOT REPLY: {len(data)} bytes from {addr}')
except socket.timeout:
    print('  no reply (either UDP blocked / dropped / server silently discards junk)')
except Exception as e:
    print(f'  socket error: {e}')
finally:
    sock.close()


# -------- 3. QUIC Initial (RFC 9000) --------
# Build a minimal-but-valid Initial packet for QUIC version 1 (0x00000001).
# Server MUST respond with either:
#   - Version Negotiation packet (if it hates v1)
#   - Initial packet containing CRYPTO frame (ServerHello)
# If we get bytes back, UDP path is confirmed alive.
step('3) Real QUIC Initial packet, listen 3 s')

def make_initial_packet():
    # QUIC long-header Initial layout (very trimmed).
    # 1 byte:  0xC0 = 0b11000000 (long header, Initial, packet number length 1)
    # 4 bytes: version = 0x00000001
    # 1 byte:  DCID len (8)
    # 8 bytes: DCID (random)
    # 1 byte:  SCID len (8)
    # 8 bytes: SCID (random)
    # 1 byte:  token length = 0
    # var:     length = payload len (packet number + payload)
    # 1 byte:  packet number = 0
    # payload: PADDING frames (0x00) to hit 1200 bytes total (QUIC min for Initial)
    dcid = os.urandom(8)
    scid = os.urandom(8)
    hdr = b'\xC0' + b'\x00\x00\x00\x01' + b'\x08' + dcid + b'\x08' + scid + b'\x00'
    # length: 1 (pn) + padding = 1200 - len(hdr) - 2 (varint length field)
    remaining = 1200 - len(hdr) - 2
    length_field = 0x4000 | remaining          # 2-byte varint
    length_bytes = struct.pack('>H', length_field)
    packet_number = b'\x00'
    padding = b'\x00' * (remaining - 1)
    return hdr + length_bytes + packet_number + padding

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(3.0)
try:
    packet = make_initial_packet()
    print(f'  sending {len(packet)}-byte QUIC Initial to {ip}:{PORT}')
    t0 = time.time()
    sock.sendto(packet, (ip, PORT))
    data, addr = sock.recvfrom(4096)
    dt = (time.time() - t0) * 1000
    first_byte = data[0]
    is_long_header = bool(first_byte & 0x80)
    kind = ((first_byte & 0x30) >> 4) if is_long_header else -1
    kinds = {0: 'Initial', 1: '0-RTT', 2: 'Handshake', 3: 'Retry'}
    kind_name = kinds.get(kind, 'unknown/short-header')
    if first_byte & 0x80 and data[1:5] == b'\x00\x00\x00\x00':
        kind_name = 'Version Negotiation'
    print(f'  GOT REPLY  {len(data)} bytes  after {dt:.0f} ms  ({kind_name})')
    print(f'  first 16 bytes: {data[:16].hex()}')
    print()
    print('  ✓ UDP + QUIC path to the server is WORKING.')
except socket.timeout:
    print('  timeout — QUIC server did not respond.')
    print('  Likely causes (most probable first):')
    print('    - Cloudflare Tunnel / reverse proxy in front of this domain')
    print('      does not forward UDP')
    print('    - Firewall on server drops inbound UDP :{port}'.format(port=PORT))
    print('    - ISP or middlebox filters non-443 UDP')
    print('    - Server WT process actually down')
except Exception as e:
    print(f'  socket error: {e}')
finally:
    sock.close()
