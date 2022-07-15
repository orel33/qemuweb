#!/bin/bash

[ ! $# -eq 2 ] && echo "Usage: $0 <sessionid> <switchname>" && exit 1

echo "=> Creating QemuNet switch \"$2\" for session ID \"$1\""

SESSIONID="$1"
SWITCHNAME="$2"
SESSIONDIR="/tmp/$SESSIONID"
mkdir -p $SESSIONDIR
SWITCHDIR="$SESSIONDIR/switch/$SWITCHNAME"
SWITCHMGMT="$SESSIONDIR/$SWITCHNAME.mgmt"
PIDFILE="$SESSIONDIR/$SWITCHNAME.pid"
mkdir -p $SWITCHDIR

# launch vde switch in daemon mode
CMD="vde_switch -d -s $SWITCHDIR -p $PIDFILE -M $SWITCHMGMT"
echo "[$SWITCHNAME] $CMD"
$CMD

# launch terminal for vde management sockets
CMD="vdeterm $SWITCHMGMT"
echo "[$SWITCHNAME] $CMD"
$CMD

###
