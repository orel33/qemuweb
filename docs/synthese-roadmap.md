# QemuWeb : feuille de route pour décideurs

De la version 0.9.0 (essais au CREMI) à la 2.0, en cinq étapes. Synthèse de [roadmap.md](roadmap.md), en français à la demande du responsable du projet ; le détail technique de chaque tâche est dans ce fichier.

## En bref

- **Aujourd'hui (0.9.0)** : le serveur tourne au CREMI derrière Apache et OpenID, avec un runner local, un runner distant validé et les consoles par WebSocket à travers le relais. Il est réservé à des utilisateurs de confiance : pas de quotas, de limitation des commandes ni d'isolation des machines.
- **1.0 : ouvrir à une promo entière** (environ 30 sessions simultanées) sans faire confiance aux utilisateurs : sécurité, exploitation sans surprise, test de charge, et la capture de trafic, fonction phare pour les TP de réseau.
- **1.1 à 1.3 : confort et portée** : services d'un hôte, interface retravaillée, runners sur les postes de TP, davantage de systèmes invités.
- **2.0 : au-delà des consoles série** : affichage graphique (Windows, bureaux Linux), conteneurs Docker, macOS.

**Difficulté** (ordre de grandeur de l'effort, hors décisions et tests manuels) : **1** quelques heures · **2** une journée · **3** quelques jours · **4** une à deux semaines, conception délicate · **5** chantier avec étude préalable et risques externes (privilèges, licences, performances).

## Décisions attendues

| # | Décision | Pour quand |
| --- | --- | --- |
| 1 | **Capture de trafic dans la 1.0** (ma recommandation) ou en 1.1 : elle rend la plateforme utile aux TP de réseau, mais retarde la 1.0 d'une à deux semaines | avant le lancement de CAP01 |
| 2 | **Licences Windows et macOS** : le CREMI en a-t-il pour des machines virtuelles de salle ? macOS n'est légal que sur du matériel Apple | avant la 2.0 |
| 3 | **Postes de TP** : droit d'utiliser `/dev/kvm` (groupe `kvm`), Node 24, QEMU, VDE et un dossier d'images partagé (NFS) | avant la 1.2 |
| 4 | **Compatibilité des fichiers** : une bêta peut tout casser ; à partir de la 1.0, une mise à jour qui change un format doit-elle migrer les sessions ? | avant la 1.0 |
| 5 | **Qui exploite le serveur** (mises à jour, certificat annuel, sauvegardes) et à quel rythme | avant la 1.0 |

## Version 1.0 : ouverture à la promo

*Objectif : 30 étudiants travaillent en même temps, sans pouvoir nuire aux autres ni au serveur, et l'équipe sait exploiter le service.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| AUT01 | Retirer le mode d'authentification mixte `both`, gérer l'expiration de la session OpenID en cours d'usage | 2 |
| SVC01 | Services systemd, rotation des journaux, renouvellement du certificat, contrôles au démarrage | 2 |
| DOC01 | Un seul parcours d'installation documenté, guide utilisateur à jour | 1 |
| PRP01 | Construction des images derrière le proxy du CREMI sans option particulière | 1 |
| RUN02 | Les sessions d'un runner distant survivent au redémarrage du serveur, perte forcée par l'administrateur | 4 |
| SEC01 | Mot de passe minimal, ralentissement des échecs de connexion, contrôle de l'origine, déconnexion révocable | 3 |
| SEC02 | Liste blanche des commandes de l'hyperviseur et quotas (machine, session, serveur) | 3 |
| SEC04 | Runner sous un compte dédié, un cgroup par session limitant mémoire et processeur | 4 |
| IMG01 | Image Debian plus légère, démarrage le plus rapide, aucun trafic réseau spontané | 3 |
| CAP01 | **Capture de trafic** : fichier PCAP à télécharger pour Wireshark et vue `tcpdump` en direct | 4 |
| LOD01 | Test de charge de 30 sessions simultanées, équilibrage selon la mémoire libre | 3 |
| QUA01 | Défauts ouverts corrigés, fiche de test manuelle déroulée en production, PDF à jour | 2 |

*Critère de sortie* : le test de charge passe sans machine tuée, une commande interdite est refusée, un dépassement de quota donne un message clair, et la fiche de test est déroulée sur le serveur du CREMI.

## Version 1.1 : confort pour les enseignants et les étudiants

*Objectif : une interface plus claire et des machines qui rendent des services sans configuration manuelle.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| HSV01 | Onglet « Services » d'un hôte : DHCP, DNS, web, FTP, telnet… à cocher, appliqués au redémarrage | 4 |
| FIL01 | Un seul bouton Load et un seul Save (topologie `.topo` ou session `.zip`), avec les fichiers d'exemple du serveur | 3 |
| UXS01 | Conception écrite de l'interface autour de la session, validée par l'utilisateur | 2 |
| UXS02 | Session créée à la connexion, une seule action « Reset » à la place de deux boutons confus | 2 |
| UXS03 | Actions regroupées en catégories claires : Session, Nœuds, Affichage | 2 |
| UXS04 | Mode édition et mode exécution, un seul endroit décide des contrôles actifs | 4 |
| NET01 | Couper et rebrancher un câble d'un hôte en marche (panne de lien pour les TP de routage) | 2 |
| NET02 | Points de sauvegarde d'un hôte ou d'une session : revenir à l'état d'avant une erreur | 4 |
| NET03 | Ajouter ou retirer une interface d'un hôte sans le redémarrer | 4 |
| ADM01 | Page d'administration en onglets (sessions, comptes, runners, WebSocket, journaux) | 2 |
| GRA02 | Plusieurs consoles flottantes dans la vue graphique | 3 |
| GRA03 | Points restants de la vue graphique : zoom au pincement, invite du shell, tooltips | 2 |
| GRA04 | Relier deux nœuds en glissant d'une prise à l'autre dans la vue graphique | 3 |
| BUG01 à BUG08, TOD01 à TOD07 | Petites tâches indépendantes de l'annexe, à prendre au fil des creux | 1 |

*Critère de sortie* : un étudiant sans aide sait créer, lancer, arrêter et remettre à zéro sa session, et reconnaît les actions de session de celles d'un nœud.

## Version 1.2 : les postes de TP deviennent des runners

*Objectif : en salle de TP, les machines tournent sur le poste de l'étudiant ; à la maison, sur le serveur.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| PRN01 | Côté serveur : un runner et un jeton appartiennent à un utilisateur, la session nouvelle va sur son runner s'il est en ligne | 4 |
| SEC03 | Un runner d'étudiant n'est pas de confiance : tout ce qu'il envoie est validé et borné | 4 |
| PRN02 | Page « My runner » : créer son jeton, copier la commande, voir l'état, révoquer | 2 |
| PRN03 | Images de base : dossier partagé NFS ou téléchargement vérifié, fiche d'installation d'un poste | 3 |

*Critère de sortie* : un étudiant enregistre son poste de TP et sa session s'y place ; un autre étudiant ne peut pas y placer la sienne. Prérequis : décision 3.

## Version 1.3 : davantage de systèmes et d'échanges

*Objectif : élargir la palette de TP (routage, autres Unix) et faciliter l'échange de fichiers.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| GST01 | Nouveaux systèmes en console série : Tiny Core, Alpine avec FRRouting, VyOS, FreeBSD ou OpenBSD (par système) | 2 |
| SHR01 | Dossier partagé entre l'hôte et la machine (9p), avec téléversement et téléchargement dans l'interface | 4 |
| CLI01 | Mode autonome sans serveur web : machines locales et terminaux `xterm` ou `tmux` | 4 |

*Critère de sortie* : un TP de routage dynamique (OSPF ou BGP) tourne avec des machines de plusieurs systèmes, et un fichier passe de l'étudiant à sa machine sans passer par le réseau.

## Version 2.0 : graphique, conteneurs, autres plates-formes

*Objectif : accueillir des systèmes qui ne se pilotent pas en console série.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| DSP01 | Affichage graphique dans le navigateur (VNC et noVNC) pour les machines qui ont un écran | 5 |
| WIN01 | Machines Windows (XP, 10, 11) avec une image fournie par l'utilisateur ; **dépend des licences** | 5 |
| ENG01 | Moteur Docker : un conteneur relié au réseau VDE ; **demande des privilèges** | 5 |
| ENG02 | Images Docker lancées comme machines virtuelles (boot2container), sans les problèmes de privilège | 4 |
| ENG03 | Machines macOS ; **possible seulement sur matériel Apple**, à décider avec le CREMI | 5 |

*Critère de sortie* : un système graphique tourne et se pilote dans le navigateur, avec un coût de ressources chiffré et un plafond par utilisateur.

## Risques à surveiller

| Risque | Conséquence | Parade |
| --- | --- | --- |
| Ouvrir avant la sécurité | Un étudiant malveillant occupe ou casse le serveur | N'ouvrir la promo qu'à la fin de la 1.0 (sécurité et charge) |
| Le relais du CREMI n'est pas à nous | Les consoles tombent si ses réglages changent | Test `curl` documenté, panneau « Connections » de l'administration |
| Machines graphiques et Windows | Mémoire et disque hors de proportion avec 30 sessions | Plafond par utilisateur, runners dédiés, quelques machines partagées |
| Runners d'étudiants | Données non fiables dans le serveur | SEC03 avant PRN02, jamais l'inverse |
| Changement de format entre deux versions | Sessions illisibles après une mise à jour | Décision 4, avertissement du serveur au démarrage |
