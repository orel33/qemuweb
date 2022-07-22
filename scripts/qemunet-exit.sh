#!/bin/bash

[ ! $# -eq 1 ] && echo "Usage: $0 <sessionid>" && exit 1

echo "=> Exiting QemuNet session ID \"$1\""

SESSIONID="$1"
SESSIONDIR="/tmp/$SESSIONID"
[ ! -d "$SESSIONDIR" ] && echo "Error: Invalid session ID or session directory not found!" && exit 1

# killing all
shopt -s nullglob # a pattern that matches nothing "disappears"
for pidfile in $SESSIONDIR/*.pid ; do
    PID=$(cat $pidfile)
    disown $PID 2> /dev/null
    echo "killing $pidfile ($PID)"
    kill $PID 2> /dev/null
done

# clean session files
rm -rf $SESSIONDIR/switch
rm -f $SESSIONDIR/*.pid $SESSIONDIR/*.mgmt $SESSIONDIR/*.log

###

