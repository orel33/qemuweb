# QemuNet : démonstrateur de console série

Ce projet démarre une image live Alpine dans QEMU ou VirtualBox et relaie sa console série `ttyS0` vers xterm.js dans un serveur web local. Il sert à valider le terminal interactif avant de reconstruire le projet pédagogique étape par étape.

La VM est lancée sans réseau et sans disque persistant : aucune donnée n’est conservée après l’arrêt. L’ISO Alpine virt est téléchargée dans `runtime/` et vérifiée avec le SHA-256 publié par Alpine. Cette image fournit une console série prête à l’emploi ([image officielle](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.3-x86_64.iso), [configuration de la console série](https://wiki.alpinelinux.org/wiki/Enable_Serial_Console_on_Boot)).

## Prérequis

- Linux x86_64
- Node.js 18 ou plus récent et npm
- `curl` et `sha256sum`
- Pour le moteur QEMU : `qemu-system-x86_64`. KVM est utilisé si `/dev/kvm` est accessible en lecture et écriture ; sinon QEMU fonctionne en émulation logicielle, plus lente.
- Pour le moteur VirtualBox : VirtualBox et `VBoxManage`. VT-x/AMD-V doit être disponible ; une VM KVM en cours peut empêcher VirtualBox de démarrer.

QEMU et VirtualBox sont interchangeables dans la page ; il n’est pas nécessaire d’installer les deux. Aucun VDE ni backend QemuNet n’est utilisé.

## Installation

Depuis un terminal :

```sh
git clone --branch main https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash prepare.sh
```

`npm ci` installe les dépendances JavaScript à partir du verrou npm. `prepare.sh` télécharge l’ISO Alpine virt si elle n’est pas déjà présente et vérifie son empreinte.

## Lancement

À la racine du dépôt :

```sh
npm start
```

Ouvre <http://127.0.0.1:3002>, choisis QEMU ou VirtualBox, puis clique sur **Démarrer**. Au prompt `login:`, saisis `root` et appuie sur Entrée ; le mot de passe est vide. Clique dans le terminal si tu dois lui redonner le focus.

Arrête la VM avec le bouton **Arrêter**, puis le serveur avec Ctrl+C dans le terminal où `npm start` tourne. L’état de la page indique `QEMU/KVM` ou `QEMU/TCG` pour préciser l’accélération utilisée.
