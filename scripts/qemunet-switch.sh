#!/bin/bash

[ ! $# -eq 2 ] && echo "Usage: $0 <sessionid> <switchname>" && exit 1

echo "=> Launching QemuNet switch \"$2\" for session ID \"$1\""

set -e # immediately exit on first error

# input parameters
SESSIONID="$1"
SWITCHNAME="$2"

# session directory
SESSIONDIR="/tmp/$SESSIONID"
mkdir -p $SESSIONDIR

# switch config
SWITCHDIR="$SESSIONDIR/switch/$SWITCHNAME"
SWITCHMGMT="$SESSIONDIR/$SWITCHNAME.mgmt"
PIDFILE="$SESSIONDIR/$SWITCHNAME.pid"
mkdir -p $SWITCHDIR

# launch vde switch in daemon mode
CMD="vde_switch -d -s $SWITCHDIR -p $PIDFILE -M $SWITCHMGMT"
CMDFILE="$SESSIONDIR/$SWITCHNAME.sh"
echo "$CMD" > $CMDFILE
( set -x ; $CMD )

# launch terminal for vde management sockets
vdeterm $SWITCHMGMT

###
