#!/bin/bash

XOPT="-e DISPLAY=$DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix"

# https://stackoverflow.com/questions/48422001/how-to-launch-qemu-kvm-from-inside-a-docker-container
# KVMGID=$(...) # 108, on my host, but not on VM!
# KOPT="--device /dev/kvm --group-add $KVMGID"

KOPT="--privileged -v /dev/kvm:/dev/kvm" # insecure !

docker run -it $XOPT $KOPT -p 3000:3000 orel33/qemuweb

