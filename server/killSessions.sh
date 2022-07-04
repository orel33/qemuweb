#!/bin/bash

userid=$1

if [ -z "$1" ]
then
	echo "No argument supplied, you have to give userid in first argument."
fi

if [[ ! -z "$2" ]]
then
	echo "Waiting for $2 minutes before killing all sessions beginning with $1"
	sleep $2m
fi

while true
do
	session="$(tmux ls | grep -o ${userid}.. | head -n1)"
	if [ -z "$session" ]
	then
		break
	fi
	tmux kill-session -t $session
	echo "Killed ${session}"
done
