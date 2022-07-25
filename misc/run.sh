#!/bin/bash

XOPT="-e DISPLAY=$DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix"
# KVMGID=$(...) # 108, on my host, but not on VM!
# KOPT="--device /dev/kvm --group-add $KVMGID"
KOPT="--privileged -v /dev/kvm:/dev/kvm" # insecure !

docker run -it $XOPT $KOPT orel33/qemuweb

