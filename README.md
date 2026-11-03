# QemuNet : démonstrateur de console série

Cette démo lance Alpine Linux, Debian 13 ou OpenWrt dans QEMU ou VirtualBox, et relaie la console série `ttyS0` vers xterm.js dans un serveur web local.

## Principe des images

`prepare.sh` prépare les systèmes avant leur utilisation :

- **Alpine** reste une ISO live.
- **Debian 13** : le script télécharge et vérifie l’image cloud officielle, la démarre une fois dans une VM QEMU temporaire isolée, prépare les comptes `root`, `toto` et `demo`, configure l’accès série et le réseau DHCP, désactive cloud-init pour les démarrages suivants, puis produit une image RAW en lecture seule.
- **OpenWrt** : le script vérifie et décompresse l’image officielle RAW.
- Pour **VirtualBox**, le script convertit chaque image RAW en VDI de base en lecture seule.

Au lancement, le serveur ne configure plus aucun système : QEMU crée un QCOW2 différentiel basé sur le RAW ; VirtualBox crée un VDI différentiel basé sur le VDI préparé. Chaque instance a ses écritures à elle, supprimées à l’arrêt. Les fichiers de base dans `runtime/` ne sont jamais modifiés.

### Matrice des formats disque

| Moteur | Image source en lecture seule | Disque différentiel inscriptible | Statut dans cette démo |
|---|---|---|---|
| QEMU | RAW | QCOW2 | **Utilisé** : le QCOW2 s’appuie directement sur la RAW. |
| QEMU | VDI | QCOW2 | Possible ; QEMU sait lire une VDI comme base. |
| QEMU | VDI | VDI | Non pris en charge par le QEMU testé : son pilote VDI ne crée pas de disque différentiel. |
| VirtualBox | VDI | VDI | **Utilisé** : le VDI différentiel dépend du VDI préparé. |
| VirtualBox | RAW | VDI | Pas de lien différentiel direct ; le RAW doit d’abord être converti en VDI. |

La RAW reste la source maître commune. `prepare.sh` crée aussi une VDI en lecture seule pour VirtualBox, ce qui consomme de l’espace disque supplémentaire ; VirtualBox ne sait pas utiliser directement la RAW comme parent d’un VDI différentiel. Les compatibilités indiquées ont été vérifiées avec QEMU 8.2.2 et VirtualBox 7.1.14.

La préparation télécharge les images manquantes depuis les dépôts officiels, puis les vérifie avec les sommes publiées. Une fois les images préparées, le démarrage et l’exécution des VM ne nécessitent aucun téléchargement ni service cloud.

## Prérequis

- Linux x86_64, Node.js 18 ou plus récent et npm.
- `curl`, `sha256sum`, `sha512sum`, `gzip` et `qemu-img`. `qemu-img` sert à préparer les bases et à créer les overlays QEMU.
- Pour préparer Debian, `qemu-system-x86_64`, `genisoimage` et `python3` sont également requis. KVM accélère la préparation si `/dev/kvm` est accessible en lecture et écriture ; sinon elle utilise TCG, plus lent.
- Pour lancer avec QEMU : `qemu-system-x86_64`. Pour lancer avec VirtualBox : VirtualBox et `VBoxManage`.

## Installation et préparation

```sh
git clone --branch main https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash prepare.sh
```

Le script place dans `runtime/` les images officielles, les bases préparées en RAW et VDI, ainsi que `catalog.json`, utilisé pour alimenter le menu de la page. Les images et les disques temporaires sont ignorés par Git.

## Lancement

```sh
npm start
```

Ouvre <http://127.0.0.1:3002>, choisis un système et un moteur, puis clique sur **Démarrer**. Le panneau **Journal de lancement** affiche les commandes QEMU ou VirtualBox. Les identifiants apparaissent au-dessus du terminal :

- **Alpine Linux 3.24** : `root`, mot de passe vide ; ISO live sans disque ni réseau.
- **Debian 13** : `root` sans mot de passe ; `toto` / `toto` ou `demo` / `serial-demo` ; disque différentiel éphémère, DHCP restreint dans QEMU et NAT dans VirtualBox.
- **OpenWrt 25.12 x86-64** : appuie sur Entrée pour ouvrir le shell `root` sans mot de passe ; disque différentiel éphémère, réseau désactivé.

Arrête la VM avec le bouton **Arrêter**, puis le serveur avec Ctrl+C dans le terminal où `npm start` tourne. Si le port 3002 est déjà pris, arrête l’ancien serveur ou choisis un autre port :

```sh
PORT=3003 npm start
```

## Images officielles

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Images cloud Debian](https://cloud.debian.org/images/cloud/)
- [Images OpenWrt x86-64](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
