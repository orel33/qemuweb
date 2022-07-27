#!/bin/bash

[ ! $# -ge 3 ] && echo "Usage: $0 <sessionid> <sysname> <hostname> <switch0>:<port0> <switch1>:<port1> [...]" && exit 1

echo "=> Launching QemuNet host \"$3\" (system \"$2\") for session ID \"$1\""

# input parameters
SESSIONID="$1"
SYSNAME="$2"
HOSTNAME="$3"
shift 3
NETARGS=$*

# session directory
SESSIONDIR="/tmp/$SESSIONID"
mkdir -p $SESSIONDIR

# image directory
# QEMUNETDIR="$(dirname $(readlink -f $0))"
# IMGDIR="$QEMUNETDIR/images"
IMGDIR="$HOME/images"

# system configuration
HOSTFS="$IMGDIR/$SYSNAME.img"
HOSTOPT="-m 200"
# HOSTKERNEL="$IMGDIR/$SYSNAME.vmlinuz"
# HOSTINITRD="$IMGDIR/$SYSNAME.initrd"
HOSTQCOW="$SESSIONDIR/$HOSTNAME.qcow2"

# create system image (qcow2)
CMD="qemu-img create -q -b $HOSTFS -F raw -f qcow2 $HOSTQCOW"
( set -x ; $CMD )

# qemu host options
BASICOPT="-name $HOSTNAME -rtc base=localtime -k fr -M accel=kvm -nographic"
DRIVEOPT="-drive file=$HOSTQCOW,format=qcow2,index=0,media=disk"
# KERNELARGS="root=/dev/sda1 rw net.ifnames=0 console=ttyS0 console=tty0"
# SYSOPT="-kernel $HOSTKERNEL -initrd $HOSTINITRD -append '$KERNELARGS'"

# qemu network options
NETDEV="e1000"
NETOPT=""
IFACENUM=0
HOSTNUM=1 # random ?
for NETARG in $NETARGS ; do
    SWITCHNAME=$(cut -d: -f1 <<< "$NETARG")
    PORTNUM=$(cut -d: -f2 <<< "$NETARG")
    MAC=$(printf "AA:AA:AA:AA:%02x:%02x" $HOSTNUM $IFACENUM)
    SWITCHDIR="$SESSIONDIR/switch/$SWITCHNAME"
    NETOPT="$NETOPT -netdev vde,sock=$SWITCHDIR,port=$PORTNUM,id=$SWITCHNAME -device $NETDEV,netdev=$SWITCHNAME,mac=$MAC"
    ((IFACENUM++))
done

# launch qemu...
PIDFILE="$SESSIONDIR/$HOSTNAME.pid"
CMD="qemu-system-x86_64 $BASICOPT $HOSTOPT $DRIVEOPT $NETOPT $SYSOPT -pidfile $PIDFILE"
CMDFILE="$SESSIONDIR/$HOSTNAME.sh"
echo "$CMD" > $CMDFILE
( set -x ; bash -c "$CMD" )
# ( set -x ; bash -c "${CMD[@]}" )

###
