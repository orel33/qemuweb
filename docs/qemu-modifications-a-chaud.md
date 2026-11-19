# QEMU : ce qu'on peut changer à chaud

Ce qu'une machine QEMU en marche accepte de modifier par son moniteur, utile pour les TP de [QemuWeb](roadmap.md). Rédigé en français à la demande du responsable du projet. Aucune de ces commandes n'a été testée ici : elles sont à vérifier sur la version de QEMU en service (11.1.3 en développement, 8.2.2 sur Ubuntu).

## Le tableau

| À chaud | Commande du moniteur | Intérêt pour un TP | Remarque |
| --- | --- | --- | --- |
| **Couper ou rebrancher un câble** | `set_link <carte> off` puis `on` | Simuler une panne de lien sans arrêter la machine : l'invité voit « link down » puis « link up » | Simple, une commande par interface ; très peu coûteux |
| **Ajouter ou retirer une interface** | `netdev_add` puis `device_add`, et l'inverse | Brancher une machine sur un autre switch sans redémarrer (aujourd'hui, les changements d'interface s'appliquent au démarrage suivant) | Sur la machine `q35`, il faut un port PCIe libre prévu à l'avance : à vérifier |
| **Insérer ou éjecter un CD** | `change` ou `eject` (ISO) | Livrer des fichiers à une machine en marche, sans reboot | Complète le dossier partagé `SHR01`, sens unique |
| **Ajouter un disque** | `blockdev-add` puis `device_add` | Disque supplémentaire pour un TP de stockage, RAID ou LVM | Le noyau invité doit gérer le branchement à chaud |
| **Sauvegarder et restaurer l'état** | `savevm`, `loadvm`, `delvm` | Un point de sauvegarde du TP : revenir à l'état d'avant une erreur | Demande un disque `qcow2` (déjà le cas) ; à tester avec les cartes et les consoles |
| **Mémoire à la volée** | `balloon <Mo>` | Ajuster la RAM d'une machine en marche | Limitée : le pilote « balloon » doit être dans l'invité |
| **Filtres réseau** | `object_add filter-…` | `filter-dump` : capture ; `filter-mirror` ou `filter-redirector` : copie ou redirection du trafic ; `filter-buffer` : retard de paquets | Pas d'émulation fine des pertes ; pour pertes, délai et débit précis, l'outil `wirefilter` de VDE (externe) |
| **Pause et reprise** | `stop`, `cont` | Geler une machine pour l'observer | Existe sans doute déjà dans le runner |
| **Capture d'écran** | `screendump` | Aperçu d'une machine graphique, préparation de `DSP01` | Utile seulement avec un écran |
| **Mot de passe VNC** | `change vnc password` | Authentifier l'affichage graphique à chaque démarrage (`DSP01`) | — |
| **Port série en plus** | `chardev-add` | Une console de plus | Moins utile : les hôtes Debian en ont déjà deux |

## Ce qu'on en retient pour la feuille de route

1. **`set_link`, câble coupé ou rebranché** : une toute petite fonction qui sert directement les TP de réseau (panne de lien, reconvergence d'un protocole de routage). À faire juste après la capture de trafic (`CAP01`), avec laquelle elle partage ses fondations : une commande du moniteur par interface et un bouton sur le lien du graphe.
2. **Les points de sauvegarde** (`savevm`, `loadvm`) : une vraie fonction d'enseignement, avec des risques à étudier d'abord (compatibilité avec les cartes réseau et les consoles).
3. **Ajout d'interface à chaud** : supprimerait la limite actuelle « les changements d'interface s'appliquent au redémarrage ».

## Une règle à garder

L'interface ne permet jamais d'envoyer une commande brute : chaque commande devient une **fonction précise** du runner (par exemple « couper le lien de l'interface N ») qui construit elle-même la commande du moniteur. C'est aussi ce que demande la liste blanche des commandes du jalon 8 (`SEC02`).
