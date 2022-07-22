#!/bin/bash

# ./qemunet-start.sh mysession
xterm -hold -fg white -bg black -T myswitch -e ./qemunet-switch.sh mysession myswitch &
sleep 1
xterm -hold -fg white -bg black -T host1 -e ./qemunet-host.sh mysession debian10 host1 myswitch:0 &
xterm -hold -fg white -bg black -T host2 -e ./qemunet-host.sh mysession debian10 host2 myswitch:1 &
# ./qemunet-exit.sh mysession


