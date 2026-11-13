# QemuWeb

QemuWeb permet de créer et piloter, depuis un navigateur, des machines Linux
QEMU ou VirtualBox reliées par des commutateurs VDE. Il affiche leurs consoles
série, permet de gérer les hôtes et les commutateurs, et importe ou exporte des
sessions et des topologies. Son [architecture](docs/architecture.md) est décrite
séparément.

## Installation

Il faut un hôte **Linux x86-64**, Node.js **18 ou plus** avec npm, Bash, Python 3,
QEMU (`qemu-system-x86_64` avec prise en charge de VDE), `qemu-img`, `vde_switch`,
`vdeterm`, `genisoimage` et VirtualBox (`VBoxManage`). Le démarrage vérifie les
exécutables déclarés dans `.env`, même si un seul moteur est utilisé. Pour QEMU/KVM,
`/dev/kvm` doit être accessible. La préparation des images télécharge des sources
officielles ; elle nécessite aussi `curl`, `gzip`, `isoinfo` et les outils Unix
usuels.

Sur Debian ou Ubuntu, installer les dépendances disponibles dans la distribution :

```sh
sudo apt install bash build-essential coreutils findutils grep gzip curl nodejs npm python3 qemu-system-x86 qemu-utils genisoimage vde2
```

Installer également VirtualBox pour `VBoxManage`. Si le QEMU fourni par la
distribution ne prend pas en charge VDE, voir [l'installation de QEMU](misc/install-qemu.md).
Puis, à la racine du dépôt :

```sh
npm ci
bash scripts/prepare.sh
./start.sh
```

Ouvrir <http://127.0.0.1:3002>. `Ctrl+C` arrête le serveur ; `PORT=3003 ./start.sh`
utilise un autre port.

## Essayer le réseau local fourni

1. Préparer au moins l'image Debian Legacy avec `bash scripts/prepare.sh --system debian13-legacy`.
2. Dans la page, choisir le moteur dans **General Settings**, puis cliquer sur **Load session ZIP** et sélectionner [`demo/lan.zip`](demo/lan.zip).
3. Démarrer les hôtes et le commutateur s'ils ne sont pas déjà lancés. Les quatre hôtes reçoivent des adresses `192.168.0.x` par leur script de démarrage ; ouvrir leurs consoles pour essayer `ping` entre eux.

L'archive contient les réglages et scripts, mais aucun disque de travail : les
hôtes démarrent avec une image neuve. [`topo/lan.topo`](topo/lan.topo) décrit la
même disposition pour **Load topology**, sans les scripts de démarrage ni les
adresses IP. Les boutons de la page permettent aussi d'ajouter des hôtes et des
commutateurs, de les relier, puis de sauvegarder la session en ZIP.

## Images disponibles

`bash scripts/prepare.sh` prépare les quatre systèmes déclarés dans
[`config.json`](config.json) : Alpine Linux 3.24, Debian 13 Cloud, Debian 13 Legacy
et OpenWrt 25.12. Pour n'en préparer qu'un ou voir les images déjà présentes :

```sh
bash scripts/prepare.sh --system alpine
bash scripts/prepare.sh --system debian13-cloud
bash scripts/prepare.sh --system debian13-legacy
bash scripts/prepare.sh --system openwrt
bash scripts/prepare.sh --list
```

Les téléchargements et leurs contrôles vont dans `sources/<système>/` ; les bases
RAW (QEMU) et VDI (VirtualBox) sont créées dans `images/`. Une image existante est
réutilisée. `--force` reconstruit le système choisi en sauvegardant l'ancienne
paire RAW/VDI dans `images/backups/` ; arrêter d'abord ses machines, car leurs
disques de travail peuvent dépendre de l'ancienne base.

## Fichiers de configuration

| Fichier | Rôle |
| --- | --- |
| [`config.json`](config.json) | Catalogue des systèmes, images, mémoire et options QEMU ou VirtualBox. |
| `.env` et `.env.local` | Noms des exécutables et chemins locaux prioritaires ; `.env.local` reste propre à la machine. |
| `runtime/<session>/session.json` | Moteur et inventaire de la session courante. |
| `runtime/<session>/<hôte>/host.json` et `runtime/<session>/<commutateur>/switch.json` | Réglages sauvegardés des hôtes et commutateurs. |
| `runtime/<session>/<hôte>/startup/start.sh` | Commandes exécutées au démarrage de l'hôte. |
| [`topo/lan.topo`](topo/lan.topo) et autres `.topo` | Description textuelle d'une topologie, sans disques ni scripts. |

Les [exemples JSON](docs/samples/) illustrent les formats des fichiers de session.
`runtime/` contient des fichiers temporaires supprimés avec la session ; utiliser
**Save session** pour conserver une copie portable.
