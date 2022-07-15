#!/bin/bash

[ ! $# -ge 3 ] && echo "Usage: $0 <sessionid> <system> <hostname> <switch0>[:<port0>] <switch1>[:<port1>] [...]" && exit 1

echo "=> Creating QemuNet host \"$3\" (system \"$2\") for session ID \"$1\""



# qemu-img create -q -b /home/orel/Documents/qemunet/qemunet/images/debian10.img -F raw -f qcow2 /tmp/qemunet-orel-872URz/immortal.qcow2

# qemu-system-x86_64 -name immortal -rtc base=localtime -k fr -M accel=kvm -m 200 -drive file=/tmp/qemunet-orel-872URz/immortal.qcow2,format=qcow2,index=0,media=disk -fsdev local,id=share0,path=/tmp/qemunet-orel-872URz/immortal,security_model=mapped -device virtio-9p-pci,fsdev=share0,mount_tag=host  -netdev vde,sock=/tmp/qemunet-orel-872URz/switch/s1,port=1,id=s1 -device e1000,netdev=s1,mac=AA:AA:AA:AA:00:00 -kernel /home/orel/Documents/qemunet/qemunet/images/debian10.vmlinuz -initrd /home/orel/Documents/qemunet/qemunet/images/debian10.initrd -append 'root=/dev/sda1 rw net.ifnames=0 console=ttyS0 console=tty0 user=orel ' -pidfile /tmp/qemunet-orel-872URz/immortal.pid -nographic

###
