# QemuNet : démonstrateur de console série

Cette démo lance Alpine Linux, Debian 13 ou OpenWrt dans QEMU ou VirtualBox, et relaie la console série `ttyS0` vers xterm.js dans un serveur web local.

## Principe des images

`prepare.sh` prépare les systèmes avant leur utilisation :

- **Alpine** reste une ISO live.
- **Debian 13** : le script télécharge et vérifie l’image cloud officielle, la démarre une fois dans une VM QEMU temporaire isolée, prépare les comptes `root`, `toto` et `demo`, configure l’accès série et le réseau DHCP, désactive cloud-init pour les démarrages suivants, puis produit une image RAW en lecture seule.
- **OpenWrt** : le script vérifie et décompresse l’image officielle RAW.
- Pour **VirtualBox**, le script convertit chaque image RAW en VDI de base en lecture seule.

Au lancement, le serveur ne configure plus aucun système : QEMU crée un QCOW2 différentiel basé sur le RAW ; VirtualBox crée un VDI différentiel basé sur le VDI préparé. Chaque instance a ses écritures à elle, supprimées à l’arrêt. Les fichiers de base dans `runtime/` ne sont jamais modifiés.

### Formats utilisés

| Moteur | Base en lecture seule | Disque différentiel de l’instance |
|---|---|---|
| QEMU | RAW | QCOW2 |
| VirtualBox | VDI converti depuis la même RAW | VDI différentiel |

La RAW reste la source maître. `prepare.sh` produit une base VDI supplémentaire pour VirtualBox ; elle prend donc de l’espace disque. Les deux moteurs utilisent le même contenu OS, mais chacun crée son propre disque de travail. Les bases ne sont jamais modifiées.

### Conversions et commandes

Les commandes équivalentes aux étapes exécutées par le projet sont :

```sh
# Conversion de la base RAW en VDI (préparation VirtualBox)
qemu-img convert -f raw -O vdi base.raw base.vdi

# Disque de travail QEMU basé sur la RAW
qemu-img create -f qcow2 -F raw -b base.raw instance.qcow2

# Disque différentiel VirtualBox basé sur la VDI
VBoxManage createmedium disk --filename instance.vdi --diffparent base.vdi --format VDI
```

VirtualBox peut aussi convertir la RAW en VDI avec `VBoxManage convertfromraw base.raw base.vdi --format VDI`. QEMU peut utiliser une VDI comme base d’un QCOW2 en remplaçant `-F raw` par `-F vdi` dans la commande de création d’overlay. Ces deux variantes ne sont pas utilisées par la démo.

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

Ouvre <http://127.0.0.1:3002>. Chaque onglet représente une VM : **＋ Nouvelle machine** crée un nouvel onglet. Choisis un système et un moteur, puis clique une fois sur **Démarrer**. Le nom de l’onglet est le hostname de l’image ; le nom de l’OS apparaît dans son infobulle. Les VM des autres onglets continuent de tourner en parallèle. Les sorties série et les journaux sont propres à chaque machine ; coche **Logs** pour afficher les commandes QEMU ou VirtualBox. La croix de l’onglet force l’arrêt immédiat de sa VM et supprime toute la session : disque différentiel, sockets, logs et enregistrement VirtualBox. Elle annule également un Reboot ou Reset en cours. Les identifiants apparaissent au-dessus du terminal :

QEMU sélectionne KVM quand il est disponible. Pour faire tourner QEMU en même temps que VirtualBox, choisis **QEMU · TCG** (émulation logicielle, plus lente) avant de démarrer QEMU. Si VirtualBox est déjà lancé, le choix **QEMU · KVM auto** bascule automatiquement cette nouvelle VM en TCG. VirtualBox ne peut pas démarrer tant qu’une VM QEMU utilise KVM ; l’interface affiche alors un message qui explique comment relancer les VM en mode compatible.

- **Alpine Linux 3.24** : `root`, mot de passe vide ; ISO live sans disque ni réseau.
- **Debian 13** : `root` sans mot de passe ; `toto` / `toto` ou `demo` / `serial-demo` ; disque différentiel éphémère, DHCP restreint dans QEMU et NAT dans VirtualBox.
- **OpenWrt 25.12 x86-64** : appuie sur Entrée pour ouvrir le shell `root` sans mot de passe ; disque différentiel éphémère, réseau désactivé.

**Reboot** demande un arrêt propre du système, puis relance la VM sur le même disque différentiel : toutes les modifications écrites dans ce disque sont conservées. **Reset** affiche un avertissement, arrête uniquement la VM de l’onglet courant, supprime son disque différentiel, en recrée un depuis l’image de base, puis la redémarre : les autres VM ne sont pas affectées. Pour Alpine, qui démarre depuis une ISO sans disque de travail, les deux commandes relancent simplement l’ISO. Ces commandes gardent le même onglet et le même hostname. Si tu utilises **Arrêter**, tu peux ensuite choisir **Reset** pour la redémarrer depuis sa base ; le bouton **Démarrer** reste réservé au premier lancement de l’onglet. Fermer un onglet arrête et supprime sa session. Quand tu arrêtes le serveur avec Ctrl+C, toutes les VM qu’il gère sont arrêtées.

Si le port 3002 est déjà pris, arrête l’ancien serveur ou choisis un autre port :

```sh
PORT=3003 npm start
```

## Images officielles

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Images cloud Debian](https://cloud.debian.org/images/cloud/)
- [Images OpenWrt x86-64](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
