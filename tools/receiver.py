#!/usr/bin/env python3
"""
Phone MIDI CC - UDP 接收端

从手机接收 UDP MIDI CC 消息，转发到本机虚拟 MIDI 端口。

用法:
  pip install mido python-rtmidi
  python receiver.py [port]

默认监听 UDP 5005 端口，创建虚拟 MIDI 输出端口 "Phone MIDI CC"。

如果没有 MIDI 回环驱动：
  Windows: 安装 loopMIDI (https://www.tobias-erichsen.de/software/loopmidi.html)
  macOS:    IAC Driver 已内建 (Audio MIDI Setup → 打开 IAC Driver)
  Linux:   sudo modprobe snd-virmidi
"""

import sys
import socket
import struct
import mido
from mido import Message

UDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5005


def main():
    # 创建虚拟 MIDI 输出端口
    port_name = "Phone MIDI CC"
    try:
        outport = mido.open_output(port_name, virtual=True)
        print(f"✅ 已创建虚拟 MIDI 端口: {port_name}")
    except Exception as e:
        print(f"❌ 无法创建虚拟 MIDI 端口: {e}")
        print("   Windows: 确保已安装 loopMIDI")
        print("   macOS:   打开 Audio MIDI Setup → 启用 IAC Driver")
        print("   Linux:   sudo modprobe snd-virmidi")
        sys.exit(1)

    # 监听 UDP
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", UDP_PORT))
    sock.settimeout(1.0)

    print(f"🎧 监听 UDP {UDP_PORT} ...")
    print(f"   在 DAW 中打开 MIDI 输入: {port_name}")
    print("   按 Ctrl+C 退出\n")

    cc_count = 0
    try:
        while True:
            try:
                data, addr = sock.recvfrom(64)
            except socket.timeout:
                continue

            if len(data) < 3:
                continue

            status = data[0]
            msg_type = status >> 4
            channel = status & 0x0F

            if msg_type == 0xB:  # CC
                cc = data[1]
                value = data[2]
                msg = Message("control_change", channel=channel, control=cc, value=value)
                outport.send(msg)
                cc_count += 1
                if cc_count % 100 == 0:
                    print(f"  📨 已发送 {cc_count} 条 CC 消息 (最近: CC{cc} = {value})")
            elif msg_type == 0x9:  # Note On
                note, vel = data[1], data[2]
                msg = Message("note_on", channel=channel, note=note, velocity=vel)
                outport.send(msg)
            elif msg_type == 0x8:  # Note Off
                note, vel = data[1], data[2]
                msg = Message("note_off", channel=channel, note=note, velocity=vel)
                outport.send(msg)
            elif msg_type == 0xE:  # Pitch Bend
                lsb = data[1] & 0x7F
                msb = data[2] & 0x7F
                val = (msb << 7) | lsb
                msg = Message("pitchwheel", channel=channel, pitch=val)
                outport.send(msg)
            else:
                # Unknown - print raw bytes once
                print(f"  未知消息: {data.hex()} 来自 {addr}")

    except KeyboardInterrupt:
        print(f"\n📊 总计发送 {cc_count} 条 CC 消息")
    finally:
        sock.close()
        outport.close()
        print("👋 已退出")


if __name__ == "__main__":
    main()
