# QemuNet : démonstrateur de console série

Cette démo lance trois systèmes dans QEMU ou VirtualBox et relaie leur console série `ttyS0` vers xterm.js dans un serveur web local : Alpine Linux live, Debian 13 cloud et OpenWrt x86-64. La liste affichée dans la page est construite par `prepare.sh` à partir des images présentes dans `runtime/`.

## Prérequis

- Linux x86_64, Node.js 18 ou plus récent, npm, `curl`, `sha256sum`, `sha512sum`, `gzip` et `genisoimage`.
- Pour QEMU : `qemu-system-x86_64` et `qemu-img`. KVM est utilisé si `/dev/kvm` est accessible en lecture et écriture ; sinon QEMU fonctionne en émulation logicielle, plus lente.
- Pour VirtualBox : VirtualBox et `VBoxManage`. `qemu-img` est également utilisé pour créer un disque temporaire compatible VirtualBox. VT-x/AMD-V doit être disponible.

Les images Debian cloud et OpenWrt sont téléchargées depuis leurs serveurs officiels et vérifiées avec les sommes publiées. Debian 13 générique cloud fait environ 325 Mo. Les fichiers et le catalogue restent dans `runtime/` (ignoré par Git).

## Installation et préparation

```sh
git clone --branch main https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash prepare.sh
```

Le script télécharge et vérifie Alpine 3.24, l’image cloud Debian 13 amd64 et OpenWrt 25.12 x86-64. Il crée ensuite `runtime/catalog.json`, qui sert de catalogue au menu.

## Lancement

```sh
npm start
```

Ouvre <http://127.0.0.1:3002>, choisis un système et un moteur, puis clique sur **Démarrer**. Le panneau **Journal de lancement** affiche les commandes QEMU ou VirtualBox, les conversions de disques et les sorties du processus. Les identifiants apparaissent au-dessus du terminal :

- **Alpine Linux 3.24** : `root`, mot de passe vide ; système live, sans disque ni réseau.
- **Debian 13 cloud** : `demo` / `serial-demo` ; disque éphémère, réseau DHCP restreint dans QEMU et NAT dans VirtualBox. Le mot de passe est prévu pour cette démo locale uniquement.
- **OpenWrt 25.12 x86-64** : `root`, aucun mot de passe au premier accès ; disque éphémère, réseau désactivé.

Arrête la VM avec le bouton **Arrêter**, puis le serveur avec Ctrl+C dans le terminal où `npm start` tourne. Si le port 3002 est déjà pris, arrête l’ancien serveur ou choisis un autre port :

```sh
PORT=3003 npm start
```

La sortie du serveur indiquera l’URL correspondante. QEMU utilise KVM si disponible, sinon TCG ; VirtualBox requiert VT-x/AMD-V disponible.

## Images officielles

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Images cloud Debian](https://cloud.debian.org/images/cloud/)
- [Images OpenWrt x86-64](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
