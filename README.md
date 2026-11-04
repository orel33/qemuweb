# QemuNet : démonstrateur de console série

Cette démo lance Alpine Linux, Debian 13 ou OpenWrt dans QEMU ou VirtualBox, et relaie la console série `ttyS0` vers xterm.js dans un serveur web local.

## Console texte : xterm et navigateur

Dans l’ancienne commande QemuNet, `-append '… console=ttyS0 …'` demande explicitement **au noyau Linux** d’écrire sur son premier port série. Avec `xterm -e qemu-system-x86_64 … -nographic`, QEMU masque la vidéo et, lorsqu’aucun `-serial` n’est indiqué, relie implicitement ce port série à son entrée/sortie standard, donc à xterm. QEMU partage aussi cette entrée/sortie avec son moniteur (`Ctrl+A`, puis `C`). Le terme `ttyS0` n’est donc pas implicite : c’est **son raccordement à xterm** qui l’est. Un service `getty` sur `ttyS0` reste nécessaire pour afficher un prompt `login:`.

Dans la démo web, `-display none` masque seulement la vidéo. `-serial unix:…` relie explicitement le port série à un socket ; le serveur transmet ensuite les caractères entre ce socket et xterm.js via WebSocket. `-monitor unix:…` ouvre un autre socket pour le moniteur QEMU. La console et le login série sont configurés dans les images pendant `prepare.sh`. La [comparaison détaillée des commandes](docs/commandes-qemu.pdf) illustre les deux trajets.

### Console série et moniteur QEMU

Les deux options utilisent ici la même syntaxe courte, mais désignent deux interfaces distinctes :

```sh
-serial unix:/chemin/console.sock,server=on,wait=off
-monitor unix:/chemin/monitor.sock,server=on,wait=off
```

`-serial` raccorde le premier port série virtuel (`ttyS0` dans Linux) au terminal interactif de l’invité : messages de démarrage, `login:`, puis shell. `-monitor` ouvre le moniteur texte HMP de **QEMU lui-même** : ses commandes pilotent l’émulateur, et ne sont pas des commandes du shell Linux. `server=on` fait écouter QEMU sur chaque socket Unix ; le serveur Node s’y connecte. `wait=off` laisse QEMU démarrer sans attendre cette connexion. La forme courte de `-serial` remplace ici l’ancien couple `-chardev socket,… -serial chardev:serial0`.

Dans la barre web, coche **Moniteur QEMU** pour saisir une commande sur la VM de l’onglet courant. Par exemple, `help` liste les commandes, `info status` indique l’état de la VM et `info block` décrit les disques. Des commandes comme `system_reset` ou `quit` modifient ou arrêtent directement la VM : utilise-les en connaissance de cause. Le moniteur est disponible pour QEMU, pas pour VirtualBox. Ses commandes et réponses sont enregistrées dans les **Logs**, même si le panneau des logs est masqué.

## Principe des images

`prepare.sh` prépare les systèmes avant leur utilisation :

- **Alpine** : le script télécharge et vérifie l’ISO `virt` officielle, l’installe de manière non interactive dans une image RAW, prépare les comptes `root` et `toto`, force le démarrage et le login sur `ttyS0`, puis produit la base VDI destinée à VirtualBox.
- **Debian 13** : le script télécharge et vérifie l’image cloud officielle, la démarre une fois dans une VM QEMU temporaire isolée, prépare les comptes `root`, `toto` et `demo`, configure l’accès série et le réseau DHCP, désactive cloud-init pour les démarrages suivants, puis produit une image RAW en lecture seule.
- **OpenWrt** : le script vérifie et décompresse l’image officielle RAW.
- Pour **VirtualBox**, le script convertit chaque image RAW en VDI de base en lecture seule.

Au lancement, le serveur ne configure plus aucun système : QEMU crée un QCOW2 différentiel basé sur le RAW ; VirtualBox crée un VDI différentiel basé sur le VDI préparé. Chaque instance a ses écritures à elle. Elles sont conservées par **Arrêter** et **Reboot**, puis supprimées par **Reset** ou par la fermeture de l’onglet. Les fichiers de base dans `images/` ne sont jamais modifiés.

`images/` contient les téléchargements officiels, les bases RAW/VDI préparées et `catalog.json`. Ce répertoire peut être conservé durablement afin de ne pas reconstruire les images. `runtime/` ne contient que les disques différentiels, sockets et états temporaires des VM ; après arrêt du serveur et des VM, son contenu peut être entièrement supprimé. Le serveur recrée le répertoire au lancement.

### Arrêt et nettoyage

```sh
./killall.sh                 # arrête tous les serveurs et VM de ce projet
./cleanall.sh                # arrête les instances et vide runtime/ ; garde images/
./cleanall.sh --images       # vide aussi images/ (la prochaine préparation recommence à zéro)
./cleanall.sh --dry-run      # affiche ce qui serait arrêté et supprimé
```

Ces scripts visent les processus QEMU/Node et les VM VirtualBox associés à ce répertoire. `cleanall.sh` conserve les fichiers `.gitkeep` et ne supprime ni le code ni `node_modules/`. L’option `--images` supprime également les éventuels autres fichiers présents dans `images/` : à utiliser uniquement si tu souhaites effacer toutes les bases conservées.

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
- Pour préparer Alpine et Debian, `qemu-system-x86_64` et `python3` sont également requis ; Debian demande aussi `genisoimage`. KVM accélère la préparation si `/dev/kvm` est accessible en lecture et écriture ; sinon elle utilise TCG, plus lent. La préparation Alpine choisit également TCG lorsqu’une VM VirtualBox tourne déjà.
- Pour lancer avec QEMU : `qemu-system-x86_64`. Pour lancer avec VirtualBox : VirtualBox et `VBoxManage`.

## Installation et préparation

```sh
git clone --branch main https://github.com/orel33/qemuweb.git
cd qemuweb
npm ci
bash prepare.sh
```

Le script place dans `images/` les images officielles, les bases préparées en RAW et VDI, ainsi que `catalog.json`, utilisé pour alimenter le menu de la page. `runtime/` est réservé aux fichiers des VM en cours. Le contenu de ces deux répertoires est ignoré par Git, à l’exception des fichiers `.gitkeep` qui conservent leur structure.

## Lancement

```sh
npm start
```

Ouvre <http://127.0.0.1:3002>. Chaque onglet représente une VM : **＋ Nouvelle machine** crée un nouvel onglet. Choisis un système et un moteur, puis clique une fois sur **Démarrer**. Le nom de l’onglet est le hostname de l’image ; le nom de l’OS apparaît dans son infobulle. Les VM des autres onglets continuent de tourner en parallèle. Les sorties série et les journaux sont propres à chaque machine ; coche **Logs** pour afficher les commandes QEMU ou VirtualBox. La croix de l’onglet force l’arrêt immédiat de sa VM et supprime toute la session : disque différentiel, sockets, logs et enregistrement VirtualBox. Elle annule également un Reboot ou Reset en cours. Les identifiants apparaissent au-dessus du terminal :

QEMU sélectionne KVM quand il est disponible. Pour faire tourner QEMU en même temps que VirtualBox, choisis **QEMU · TCG** (émulation logicielle, plus lente) avant de démarrer QEMU. Si VirtualBox est déjà lancé, le choix **QEMU · KVM auto** bascule automatiquement cette nouvelle VM en TCG. VirtualBox ne peut pas démarrer tant qu’une VM QEMU utilise KVM ; l’interface affiche alors un message qui explique comment relancer les VM en mode compatible.

En mode KVM, le serveur ajoute `-cpu host` : QEMU expose les fonctions CPU que l’hôte peut fournir à la VM. Cela évite notamment le warning `CPUID.80000001H:ECX.svm` que le modèle CPU par défaut peut produire sur un hôte Intel : `svm` désigne la virtualisation AMD, inutile pour ces VM. En mode TCG, `-cpu host` n’est pas utilisé. Ce réglage concerne le CPU virtuel, pas l’image Debian ; les VM déjà en cours gardent leur configuration jusqu’à leur prochain démarrage.

- **Alpine Linux 3.24** : `root`, mot de passe vide, ou `toto` / `toto` ; disque différentiel éphémère, DHCP restreint dans QEMU et NAT dans VirtualBox.
- **Debian 13** : `root` sans mot de passe ; `toto` / `toto` ou `demo` / `serial-demo` ; disque différentiel éphémère, DHCP restreint dans QEMU et NAT dans VirtualBox.
- **OpenWrt 25.12 x86-64** : appuie sur Entrée pour ouvrir le shell `root` sans mot de passe ; disque différentiel éphémère, réseau désactivé.

**Reboot** demande un arrêt propre du système, puis relance la VM sur le même disque différentiel : toutes les modifications écrites dans ce disque sont conservées. **Reset** affiche un avertissement, arrête uniquement la VM de l’onglet courant, supprime son disque différentiel, en recrée un depuis l’image de base, puis la redémarre : les autres VM ne sont pas affectées. Ces commandes gardent le même onglet et le même hostname. Si tu utilises **Arrêter**, tu peux ensuite choisir **Reset** pour la redémarrer depuis sa base ; le bouton **Démarrer** reste réservé au premier lancement de l’onglet. Fermer un onglet arrête et supprime sa session. Quand tu arrêtes le serveur avec Ctrl+C, toutes les VM qu’il gère sont arrêtées.

Si le port 3002 est déjà pris, arrête l’ancien serveur ou choisis un autre port :

```sh
PORT=3003 npm start
```

## Images officielles

- [Alpine Linux virt](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/)
- [Images cloud Debian](https://cloud.debian.org/images/cloud/)
- [Images OpenWrt x86-64](https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/)
