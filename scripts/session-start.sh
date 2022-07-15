#!/bin/bash
USERID=$1

echo "SCRIPTS Creating Firejail[Tmux] session for user " + $USERID
mkdir /tmp/$USERID
# TO DO : vérifier que la session firejail $USERID n'existe pas déjà
firejail --noroot --private=/tmp/$USERID --private-tmp --net=none --name=$USERID