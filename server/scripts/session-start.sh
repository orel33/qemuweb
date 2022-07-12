#!/bin/bash
echo "SCRIPTS Creating Firejail[Tmux] session for user " + $1
#firejail --noroot --private=/tmp/tata --private-tmp --net=none --name $1 tmux