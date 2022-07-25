# docker image for qemuweb

FROM debian:11
LABEL maintainer="aurelien.esnard@u-bordeaux.fr"
WORKDIR /home/docker
ARG DEBIAN_FRONTEND=noninteractive

### apt tools
RUN apt-get update
RUN apt-get install -yq build-essential apt-utils apt-file gdebi

### set locales
RUN apt-get install -yq locales-all
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

### tools
RUN apt-get install -y socat rlwrap wget git unzip curl kmod tmux screen nano sudo

### x11
RUN apt-get install -y x11-apps xterm

### qemu
RUN apt-get install -y qemu-system-x86 libvirt-clients vde2

# add user toto (as sudoer)
RUN useradd -ms /bin/bash toto
RUN echo 'toto ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
RUN gpasswd -a toto sudo
RUN echo "toto:toto" | chpasswd
RUN chown -R toto:toto /home/toto
USER toto
ENV HOME /home/toto
WORKDIR /home/toto

### qemunet & qemuweb
RUN git clone https://github.com/orel33/qemunet.git
RUN git clone https://github.com/orel33/qemuweb.git

### qemu images
# RUN mkdir images && cd images && wget -q "http://aurelien.esnard.emi.u-bordeaux.fr/qemunet/debian10.tgz" && tar xvzf debian10.tgz && rm debian10.tgz
# COPY images/debian10.tgz .
# COPY images/toto .
# RUN mkdir images && mv debian10.tgz images/ && cd images && tar xvzf debian10.tgz && rm debian10.tgz

### command to run within docker
# CMD python /app/app.py
CMD virt-host-validate qemu ; bash

# EOF