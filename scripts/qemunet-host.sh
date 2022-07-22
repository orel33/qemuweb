#!/bin/bash

[ ! $# -ge 3 ] && echo "Usage: $0 <sessionid> <sysname> <hostname> <switch0>[:<port0>] <switch1>[:<port1>] [...]" && exit 1

echo "=> Launching QemuNet host \"$3\" (system \"$2\") for session ID \"$1\""

# input parameters
SESSIONID="$1"
SYSNAME="$2"
HOSTNAME="$3"
shift 3
SWITCHNAMES=$*

# session directory
SESSIONDIR="/tmp/$SESSIONID"
mkdir -p $SESSIONDIR

# image directory
# QEMUNETDIR="$(dirname $(readlink -f $0))"
# IMGDIR="$QEMUNETDIR/images"
IMGDIR="/home/orel/Documents/qemunet/qemunet/images"

# system configuration
HOSTFS="$IMGDIR/$SYSNAME.img"
HOSTOPT="-m 200"
HOSTKERNEL="$IMGDIR/$SYSNAME.vmlinuz"
HOSTINITRD="$IMGDIR/$SYSNAME.initrd"
HOSTQCOW="$SESSIONDIR/$HOSTNAME.qcow2"

# create system image (qcow2)
CMD="qemu-img create -q -b $HOSTFS -F raw -f qcow2 $HOSTQCOW"
echo $CMD >> $SESSIONLOG
( set -x ; $CMD )

# launch qemu host (without nework)
BASICOPT="-name $HOSTNAME -rtc base=localtime -k fr -M accel=kvm -nographic"
DRIVEOPT="-drive file=$HOSTQCOW,format=qcow2,index=0,media=disk"
KERNELARGS="root=/dev/sda1 rw net.ifnames=0 console=ttyS0 console=tty0"
SYSOPT="-kernel $HOSTKERNEL -initrd $HOSTINITRD -append '$KERNELARGS'"
PIDFILE="$SESSIONDIR/$HOSTNAME.pid"
CMD="qemu-system-x86_64 $BASICOPT $HOSTOPT $DRIVEOPT $SYSOPT -pidfile $PIDFILE"
CMDFILE="$SESSIONDIR/$HOSTNAME.sh"
LOGFILE="$SESSIONDIR/$HOSTNAME.log"
echo "$CMD" > $CMDFILE
( set -x ; bash -c "$CMD" |& tee $LOGFILE )
# ( set -x ; bash -c "${CMD[@]}" )

# -netdev vde,sock=/tmp/qemunet-orel-872URz/switch/s1,port=1,id=s1
# -device e1000,netdev=s1,mac=AA:AA:AA:AA:00:00

###
