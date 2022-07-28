# docker image for qemuweb

FROM debian:11
LABEL maintainer="aurelien.esnard@u-bordeaux.fr"
WORKDIR /home/docker
ARG DEBIAN_FRONTEND=noninteractive

### apt tools
RUN apt update
RUN apt -yq install build-essential apt-utils apt-file nano

### set locales
RUN apt-get install -yq locales-all
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

### tools
RUN apt -yq install wget git unzip curl kmod tmux screen sudo firejail

### x11
RUN apt -yq install x11-apps xterm

### qemu
RUN apt -yq install qemu-system-x86 libvirt-clients vde2

### node.js and dependencies for qemuweb
RUN apt -yq install nodejs npm


# add user toto (as sudoer)
RUN useradd -ms /bin/bash toto
RUN echo 'toto ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
RUN gpasswd -a toto sudo
RUN echo "toto:toto" | chpasswd
RUN chown -R toto:toto /home/toto
USER toto
ENV HOME /home/toto
WORKDIR /home/toto

### qemuweb
# RUN git clone https://github.com/orel33/qemunet.git

### qemuweb
ADD https://api.github.com/repos/orel33/qemuweb/git/refs/heads/dev version.json
RUN git clone https://github.com/orel33/qemuweb.git -b dev

### build qemuweb app
RUN cd qemuweb && npm install && cd frontend && npm install && npm run build

### qemu images
# RUN wget -q "http://aurelien.esnard.emi.u-bordeaux.fr/qemunet/debian10.tgz"
# COPY debian11.tgz qemuweb/images/
# RUN cd qemuweb/images && tar xvzSf debian11.tgz && rm debian11.tgz

### command to run within docker
# CMD python /app/app.py
# CMD virt-host-validate qemu ; bash
CMD cd qemuweb && node app.js -p 3000
# EOF