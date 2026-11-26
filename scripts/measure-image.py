#!/usr/bin/env python3
"""Measure how a Debian guest image boots: time to the login prompt, memory, disk, services, spontaneous traffic.

  scripts/measure-image.py IMAGE.raw [--boots N] [--quiet SECONDS] [--pcap FILE]
  scripts/measure-image.py IMAGE.raw --check

QEMU is started directly with KVM, not through QemuWeb: q35, host CPU, 1 vCPU, 1024 MiB, the virtio disk with
-snapshot (the image is never written), one virtio network card and no startup disk. The guest is driven on
ttyS0 with the lab account toto/toto.

Measurement: the card is connected to a UDP socket that never answers (a bare hubport stalls the card), and
QEMU's filter-dump records what the guest sends. The last boot of the N is the detailed one: it waits
--quiet seconds after the end of the boot, then counts the frames and reads the state of the guest.

--check (one boot, needs Internet access): the card is on QEMU's user network. Starts DHCP by hand, runs
'apt-get update' and installs a package, then starts the disabled services by hand. All of it stays in the
temporary snapshot.
"""
import argparse
import os
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from collections import Counter

MARK = 'ENDMARK'


class Guest:
    def __init__(self, image, network_args):
        command = ['qemu-system-x86_64', '-machine', 'q35', '-accel', 'kvm', '-cpu', 'host', '-m', '1024',
                   '-smp', '1', '-snapshot', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
                   '-drive', f'file={image},if=virtio,format=raw', *network_args]
        self.buffer = ''
        self.started = time.monotonic()
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT)

    def expect(self, pattern, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            match = re.search(pattern, self.buffer)
            if match:
                before, self.buffer = self.buffer[:match.start()], self.buffer[match.end():]
                return before
            if select.select([self.process.stdout], [], [], 0.05)[0]:
                data = os.read(self.process.stdout.fileno(), 4096)
                if not data:
                    raise SystemExit('QEMU ended:\n' + self.buffer[-1500:])
                self.buffer += data.decode('utf-8', 'replace')
        raise SystemExit(f'Timeout waiting for {pattern!r}:\n' + self.buffer[-1500:])

    def send(self, line):
        self.process.stdin.write((line + '\n').encode())
        self.process.stdin.flush()

    def run(self, command, timeout=200):
        # The quotes keep the typed command, which the console echoes, from matching the end marker.
        self.send(command + "; echo END''MARK")
        output = self.expect(MARK, timeout)
        return re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]|\r', '', output).split('\n', 1)[-1].rstrip()

    def login(self):
        """Wait for the login prompt and log in; returns the seconds from the QEMU launch to the prompt."""
        self.expect(r'login: ', 300)
        seconds = time.monotonic() - self.started
        self.send('toto')
        self.expect('Password:', 60)
        self.send('toto')
        self.expect(r'\$ ', 60)
        self.send('export SYSTEMD_PAGER=cat PAGER=cat SYSTEMD_COLORS=0; stty cols 200; '
                  'bind "set enable-bracketed-paste off"')
        self.expect(r'\$ ', 30)
        return seconds

    def stop(self):
        self.process.kill()
        self.process.wait()


def free_udp_ports():
    sockets = [socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range(2)]
    for item in sockets:
        item.bind(('127.0.0.1', 0))
    ports = [item.getsockname()[1] for item in sockets]
    for item in sockets:
        item.close()
    return ports


def frame_kind(frame):
    if len(frame) < 14:
        return 'short frame'
    ethertype = struct.unpack('!H', frame[12:14])[0]
    payload = frame[14:]
    if ethertype == 0x0806:
        return 'ARP'
    if ethertype == 0x0800 and len(payload) >= 20:
        protocol, body = payload[9], payload[(payload[0] & 15) * 4:]
        if protocol == 2:
            return 'IGMP'
        if protocol == 17 and len(body) >= 4:
            ports = struct.unpack('!HH', body[:4])
            for port, name in ((67, 'DHCPv4'), (5353, 'mDNS'), (5355, 'LLMNR'), (123, 'NTP'), (53, 'DNS')):
                if port in ports:
                    return name
        return f'IPv4 protocol {protocol}'
    if ethertype == 0x86dd and len(payload) >= 40:
        protocol, body = payload[6], payload[40:]
        if protocol == 0 and len(body) >= 8:  # hop-by-hop options (MLD reports)
            protocol, body = body[0], body[(body[1] + 1) * 8:]
        if protocol == 58 and body:
            names = {133: 'router solicitation', 135: 'neighbour solicitation', 136: 'neighbour advertisement',
                     131: 'MLD report', 143: 'MLD report'}
            return 'ICMPv6 ' + names.get(body[0], f'type {body[0]}')
        if protocol == 17 and len(body) >= 4:
            ports = struct.unpack('!HH', body[:4])
            for port, name in ((547, 'DHCPv6'), (5353, 'mDNS'), (5355, 'LLMNR'), (123, 'NTP'), (53, 'DNS')):
                if port in ports:
                    return name + ' (IPv6)'
        return f'IPv6 protocol {protocol}'
    return f'ethertype 0x{ethertype:04x}'


def read_pcap(path):
    with open(path, 'rb') as stream:
        data = stream.read()
    if len(data) < 24:
        return Counter()
    order = '<' if data[:4] == b'\xd4\xc3\xb2\xa1' else '>'
    kinds, offset = Counter(), 24
    while offset + 16 <= len(data):
        length = struct.unpack(order + 'I', data[offset + 8:offset + 12])[0]
        kinds[frame_kind(data[offset + 16:offset + 16 + length])] += 1
        offset += 16 + length
    return kinds


DETAILS = [
    ('Memory (MiB)', 'free -m'),
    ('Root filesystem (MiB)', 'df -m /'),
    ('Installed packages and their installed size',
     "dpkg-query -W -f='${db:Status-Status} ${Installed-Size}\\n' | "
     "awk '$1 == \"installed\" { n++; s += $2 } END { printf \"%d packages, %d MiB\\n\", n, s / 1024 }'"),
    ('Running services', 'systemctl list-units --type=service --state=running --no-legend --plain'),
    ('Failed units', 'systemctl --failed --no-legend --plain'),
    ('Active timers', 'systemctl list-timers --no-legend --plain'),
    ('Listening sockets', 'sudo -S -p "" ss -tulnpH <<<toto'),
    ('Slowest units', 'systemd-analyze blame | head -15'),
    ('Critical chain', 'systemd-analyze critical-chain'),
]


def measure(image, boots, quiet, pcap_copy):
    stat = os.stat(image)
    print(f'Image: {image}\nRAW file: {stat.st_size / 2**30:.2f} GiB virtual, '
          f'{stat.st_blocks * 512 / 2**30:.2f} GiB on disk')
    times = []
    with tempfile.TemporaryDirectory(prefix='qemuweb-measure-') as directory:
        pcap = os.path.join(directory, 'guest.pcap')
        for boot in range(1, boots + 1):
            local, remote = free_udp_ports()
            guest = Guest(image, ['-netdev', f'socket,id=n0,udp=127.0.0.1:{remote},localaddr=127.0.0.1:{local}',
                                  '-device', 'virtio-net-pci,netdev=n0',
                                  '-object', f'filter-dump,id=d0,netdev=n0,file={pcap}'])
            try:
                times.append(guest.login())
                guest.run('timeout 180 systemctl is-system-running --wait')
                print(f'Boot {boot}: login prompt after {times[-1]:.1f} s; {guest.run("systemd-analyze | head -1")}',
                      flush=True)
                if boot < boots:
                    continue
                print(f'Waiting {quiet} s for spontaneous traffic...', flush=True)
                time.sleep(quiet)
                kinds = read_pcap(pcap)
                print(f'\n## Frames sent without any request ({quiet} s after the boot): {sum(kinds.values())}')
                for kind, count in kinds.most_common():
                    print(f'{count:5d}  {kind}')
                if pcap_copy:
                    shutil.copyfile(pcap, pcap_copy)
                for title, command in DETAILS:
                    print(f'\n## {title}\n{guest.run(command)}', flush=True)
            finally:
                guest.stop()
    print(f'\nTime to login ({len(times)} boots): {min(times):.1f} to {max(times):.1f} s, '
          f'mean {sum(times) / len(times):.1f} s')


# Each step is (title, command); a step passes when its command exits with 0.
CHECKS = [
    ('DHCP started by hand', 'sudo timeout 60 dhclient -4 -1 eth0 && ip -4 addr show eth0 | grep inet'),
    ('apt-get update', 'sudo timeout 180 apt-get update'),
    ('Install a package', 'sudo DEBIAN_FRONTEND=noninteractive timeout 180 apt-get install -y tree && tree --version'),
    ('Start ssh', 'sudo systemctl start ssh && systemctl is-active ssh'),
    ('Start dnsmasq', 'sudo systemctl start dnsmasq && systemctl is-active dnsmasq && sudo systemctl stop dnsmasq'),
    ('Start named (bind9)', 'sudo systemctl start named && systemctl is-active named && sudo systemctl stop named'),
    ('Start apache2', 'sudo systemctl start apache2 && curl -fsS -o /dev/null http://127.0.0.1/ && echo served'),
    ('Start inetutils-inetd', 'sudo systemctl start inetutils-inetd && echo started'),
    ('Start openvpn', 'sudo systemctl start openvpn && systemctl is-active openvpn'),
    # isc-dhcp-server needs a subnet and an interface: give it both for the test.
    ('Start isc-dhcp-server',
     "sudo ip link add dhcptest type dummy && sudo ip addr add 10.99.0.1/24 dev dhcptest && "
     "sudo ip link set dhcptest up && "
     "echo 'subnet 10.99.0.0 netmask 255.255.255.0 { range 10.99.0.10 10.99.0.20; }' | "
     "sudo tee /etc/dhcp/dhcpd.conf >/dev/null && "
     "sudo sed -i 's/^INTERFACESv4=.*/INTERFACESv4=\"dhcptest\"/' /etc/default/isc-dhcp-server && "
     "sudo systemctl start isc-dhcp-server && sleep 3 && pgrep -x dhcpd >/dev/null && echo started"),
]


def check(image):
    guest = Guest(image, ['-nic', 'user,model=virtio-net-pci'])
    failed = []
    try:
        guest.login()
        guest.run('timeout 180 systemctl is-system-running --wait')
        guest.run('sudo -S -p "" -v <<<toto')
        for title, command in CHECKS:
            output = guest.run(f'{{ {command}; }} 2>&1; echo "status=$?"', 400)
            passed = output.endswith('status=0')
            print(f'{"PASS" if passed else "FAIL"}  {title}', flush=True)
            if not passed:
                failed.append(title)
                print('\n'.join(output.split('\n')[-15:]))
    finally:
        guest.stop()
    if failed:
        raise SystemExit(f'{len(failed)} step(s) failed: {", ".join(failed)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('image', help='RAW image, opened with -snapshot')
    parser.add_argument('--boots', type=int, default=4, help='number of boots (default 4)')
    parser.add_argument('--quiet', type=int, default=90, help='seconds without any request (default 90)')
    parser.add_argument('--pcap', help='keep the capture of the detailed boot in this file')
    parser.add_argument('--check', action='store_true', help='check apt and the services started by hand')
    options = parser.parse_args()
    if options.boots < 1:
        parser.error('--boots must be at least 1')
    if not os.path.isfile(options.image) or ',' in options.image:
        parser.error(f'no such image (or a comma in its path): {options.image}')
    if not shutil.which('qemu-system-x86_64'):
        parser.error('qemu-system-x86_64 not found')
    if options.check:
        check(options.image)
    else:
        measure(options.image, options.boots, options.quiet, options.pcap)


if __name__ == '__main__':
    sys.exit(main())
