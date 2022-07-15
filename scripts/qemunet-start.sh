#!/bin/bash

[ ! $# -eq 1 ] && echo "Usage: $0 <sessionid>" && exit 1

echo "=> Creating QemuNet session for session ID \"$1\""


###
