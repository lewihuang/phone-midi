#!/usr/bin/env python3
"""
Phone MIDI CC - UDP 接收端 (零依赖版本)

只需 Python 3，不需要任何第三方包。
打印收到的 CC 值到终端。
"""
import socket
import sys
import struct
import time

UDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5005

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", UDP_PORT))
sock.settimeout(1.0)

print(f"🎧 监听 UDP {UDP_PORT} ...")
print("  手机 App 设置 → DAW 目标 → IP 填本机 IP:端口 {UDP_PORT}")
print("  回到主页 → 打开发送开关")
print("  按 Ctrl+C 退出\n")

last_print = time.time()
count = 0

while True:
    try:
        data, addr = sock.recvfrom(64)
    except socket.timeout:
        continue
    except KeyboardInterrupt:
        break

    if len(data) < 3:
        continue

    status = data[0]
    msg_type = status >> 4
    channel = status & 0x0F
    count += 1

    now = time.time()

    if msg_type == 0xB:  # CC
        cc, val = data[1], data[2]
        # 进度条
        bar = "█" * (val * 20 // 127) + "░" * (20 - val * 20 // 127)
        print(f"\rCC{cc:3d} = {val:3d}  {bar}  ch.{channel}  | 收到 {count} 条  [{addr[0]}]", end="")
    elif msg_type == 0x9:  # Note On
        print(f"\n🎵 Note On  {data[1]}  vel={data[2]}  [{addr[0]}]")
    elif msg_type == 0x8:  # Note Off
        print(f"\n🔇 Note Off {data[1]}                [{addr[0]}]")
    elif msg_type == 0xE:  # Pitch Bend
        val = (data[2] & 0x7F) << 7 | (data[1] & 0x7F)
        print(f"\n↕ Pitch Bend = {val:5d}           [{addr[0]}]")
    else:
        print(f"\n❓ 未知消息 type={msg_type}  data={data.hex()}  [{addr[0]}]")
