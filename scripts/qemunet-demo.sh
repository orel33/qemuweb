#!/bin/bash

# ./qemunet-start.sh mysession
xterm -hold -fg white -bg black -T s1 -e ./qemunet-switch.sh mysession s1 &
xterm -hold -fg white -bg black -T s2 -e ./qemunet-switch.sh mysession s2 &

sleep 1

xterm -hold -fg white -bg black -T host1 -e ./qemunet-host.sh mysession debian11 host1 s1:1 &
xterm -hold -fg white -bg black -T host2 -e ./qemunet-host.sh mysession debian11 host2 s1:2 s2:2 &
xterm -hold -fg white -bg black -T host3 -e ./qemunet-host.sh mysession debian11 host3 s2:1 &

# ./qemunet-exit.sh mysession


