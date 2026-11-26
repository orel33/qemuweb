# QemuWeb : feuille de route pour décideurs

De la version 0.9.9 (essais au CREMI) à la 2.0, en cinq étapes. Synthèse de [roadmap.md](roadmap.md), en français à la demande du responsable du projet ; le détail technique de chaque tâche est dans ce fichier.

## En bref

- **Aujourd'hui (0.9.9)** : le serveur tourne au CREMI derrière Apache et OpenID, avec un runner local, un runner distant validé et les consoles par WebSocket à travers le relais. Livré depuis la 0.9.0 : la capture de trafic (fichier PCAP et vue `tcpdump`), un seul menu Load et un seul Save avec des exemples du serveur, la page d'administration en onglets, le moteur VirtualBox réparé avec un sélecteur de moteur, et la construction des quatre images derrière le proxy du CREMI. Il reste réservé à des utilisateurs de confiance : pas de quotas, de limitation des commandes ni d'isolation des machines.
- **1.0 : ouvrir à une promo entière** (environ 30 sessions simultanées) sans faire confiance aux utilisateurs : sécurité, exploitation sans surprise, test de charge, et la capture de trafic, fonction phare pour les TP de réseau.
- **1.1 à 1.3 : confort et portée** : services d'un hôte, interface retravaillée, runners sur les postes de TP, davantage de systèmes invités.
- **2.0 : au-delà des consoles série** : affichage graphique (Windows, bureaux Linux), conteneurs Docker, macOS.

**Difficulté** (ordre de grandeur de l'effort, hors décisions et tests manuels) : **1** quelques heures · **2** une journée · **3** quelques jours · **4** une à deux semaines, conception délicate · **5** chantier avec étude préalable et risques externes (privilèges, licences, performances).

## Jalons déjà atteints

| Version | Ce qui est livré |
| --- | --- |
| 0.9.0-beta.1 à beta.4 | Nommage des sessions et des nœuds, découpage du code en modules, comptes multi-utilisateurs, rôle administrateur |
| 0.9.0-beta.4.1 à beta.5.1 | Runner local en processus séparé, runners distants (jeton d'enregistrement, WebSocket authentifié, placement, délai de grâce, administration) |
| 0.9.0-beta.5.2 et 5.3 | Documentation en PDF, vue graphique reconstruite, documentation découpée dans `docs/` |
| 0.9.0-beta.5.4 | Déploiement au CREMI : Apache et OpenID, mode `--auth proxy`, comptes sans mot de passe, panneau des connexions et test WebSocket |
| **0.9.0** | Formats de fichiers stabilisés (`schemaVersion` 1), archives d'exemple réécrites, session sauvegardée en `qemuweb-session.zip` ; runner distant validé au CREMI (enregistrement, placement, coupure réseau, révocation) |
| **0.9.1** | Authentification réduite à `password` et `proxy` (expiration de la session OpenID, deux clés pour une rotation) ; **capture de trafic** : fichier PCAP d'une interface (`filter-dump` de QEMU), bouton et fenêtre Capture, vue `tcpdump` en direct, droits et journal d'audit |
| **0.9.2** | **Un seul menu Load et un seul Save** (topologie ou session), exemples du serveur (`examples/`), `tcpdump` vérifié au démarrage |
| **0.9.3** | Page d'administration en onglets ; **moteur VirtualBox réparé** (messages clairs, exclusion de KVM par runner) ; sélecteur **Engine** dans l'en-tête, réglages et disques de travail par moteur (`host.json` format 2) |
| **0.9.4** | Console ttyS1 : indice quand elle est vide et vérification dans `prepare.sh --list` ; images Alpine et OpenWrt construites **derrière le proxy du CREMI** ; `prepare.sh --hash` signale les images manquantes |
| **0.9.5** | Dossier de travail par défaut dans `/tmp/qw-<compte>/<port>` : fin de l'erreur « Runtime socket path is too long » (TOD02, validée) ; la taille de la police n'est plus affichée entre A− et A+ (elle reste dans l'infobulle) |
| **0.9.6** | **Adresse IP en direct** de chaque interface (avec son préfixe) dans la vue graphique, lue par l'agent invité de QEMU (`GAG01`) ; commande `scripts/guest-agent.sh` ; `prepare.sh` sans argument liste les images (et indique l'agent et ttyS1), `--system <id\|all>` et `--all` pour construire (`PRP02`) |
| **0.9.7** | **Runner local comme les autres** (RUN03a à f) : connexion WebSocket avec un fichier de jeton, un dossier par processus, sessions restaurées hors ligne et perte forcée ; page Admin avec colonnes Nom et ID ; `prepare.sh --parallel` ; schéma d'architecture mis à jour ; services systemd avec `scripts/qwctl.sh` (SVC01, première partie) ; adresse d'écoute `--bind` ; dialogues Load et Save Session ; liens rectilignes dans la vue graphique ; console silencieuse des images Debian |
| **0.9.8** | **Observation et contrôle cohérents** : la console flottante, sa position, la disposition des nœuds, le zoom et le style des liens suivent celui qui pilote ; l'admin qui prend le contrôle agit comme l'étudiant (Load et Save compris), l'étudiant est en lecture seule pendant ce temps ; **session implicite** et un seul bouton **Reset session** ; identifiants de 8 caractères ; page Admin : colonnes Session et Runner, état d'un runner, logs redimensionnables |
| **0.9.9** | **Image `debian13-cloud` allégée et silencieuse** : aucune trame envoyée au repos, services réseau installés mais désactivés (Apache et BIND ajoutés), image RAW réduite de 1,33 à 0,74 Gio, démarrage plus rapide ; script de mesure (`IMG03`) |

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
| PRN01 | **Priorité, code écrit, à tester** : un étudiant crée un jeton et enregistre son propre runner (côté serveur : propriétaire, limites, placement sur son runner) | 4 |
| PRN02 | **Priorité** : page « My runner » pour créer son jeton, copier la commande, voir l'état et révoquer ; message « runner offline » | 2 |
| VBX01 | **Fait (0.9.3).** Réparation prioritaire : le moteur VirtualBox ne démarre pas à côté de QEMU/KVM (VT-x occupé) ; message clair et garde par runner | 3 |
| AUT01 | **Fait.** Retirer le mode d'authentification mixte `both`, gérer l'expiration de la session OpenID en cours d'usage | 2 |
| CFG01 | Fichier `qemuweb.conf` : les emplacements par défaut d'une installation (comptes, runners, journaux, dossiers de travail), lus par le serveur, le runner et les scripts ; `user.sh` écrit alors dans le bon fichier et l'affiche | 2 |
| SVC01 | **Première partie faite (0.9.7, `qwctl.sh`).** Services systemd, rotation des journaux, renouvellement du certificat, contrôles au démarrage | 2 |
| DOC01 | Un seul parcours d'installation documenté, guide utilisateur à jour | 1 |
| PRP01 | **Fait (0.9.4)** : Construction des images derrière le proxy du CREMI sans option particulière | 1 |
| TOD02 | **Fait (0.9.5).** Dossier de travail par défaut dans `/tmp/qw-<compte>/<port>`, court et privé : fin de l'erreur « Runtime socket path is too long » | 2 |
| RUN03 | **Fait (a à f, 0.9.7)** : le runner local devient un runner comme les autres (WebSocket et fichier de jeton, un dossier par processus, plus de fichier partagé avec le serveur, sessions restaurées hors ligne au redémarrage du serveur, perte forcée) ; mise à jour du CREMI par une procédure unique | 4 |
| RUN04 | **Après la 0.9.7** : plusieurs runners (nom et type dans `status.sh`, charge homogène au placement, test à plusieurs runners) | 2 |
| RNR01 | **À décider** (contexte sauvegardé) : lignes de commande du runner plus simples (`runner.sh local` et `runner.sh remote` à la place de la commande sans mot, `register` et `run`), jeton hors de la ligne de commande | 2 |
| LST02 | Idée, non commencée : HTTPS servi directement par le serveur (`--tls-cert`, `--tls-key`, script de certificat), fin de `--insecure` sur un réseau local | 3 |
| GAG02 | Adresse IP en direct des machines VirtualBox (Guest Additions), symétrique de GAG01 qui le fait pour QEMU | 3 |
| PST01 | **Étude** (suite de RUN03, qui a déjà livré le lien session-runner et la restauration hors ligne) : politiques de persistance après un reboot ou une coupure, pour le serveur et pour le runner ; plusieurs politiques à comparer, **rien n'est décidé** | 3 |
| SEC01 | Mot de passe minimal, ralentissement des échecs de connexion, contrôle de l'origine, déconnexion révocable | 3 |
| SEC02 | Liste blanche des commandes de l'hyperviseur et quotas (machine, session, serveur) | 3 |
| SEC04 | Runner sous un compte dédié, un cgroup par session limitant mémoire et processeur | 4 |
| IMG01 | Image Debian plus légère, démarrage le plus rapide, aucun trafic réseau spontané | 3 |
| IMG03 | **Fait.** Image `debian13-cloud` allégée et silencieuse : aucune trame envoyée au repos, services réseau installés mais désactivés (Apache et BIND ajoutés), paquets inutiles retirés, image RAW réduite, script de mesure | 3 |
| CAP01 | **Fait (0.9.1).** Capture de trafic : fichier PCAP à télécharger pour Wireshark et vue `tcpdump` en direct | 4 |
| LOD01 | Test de charge de 30 sessions simultanées, équilibrage selon la mémoire libre | 3 |
| QUA01 | Défauts ouverts corrigés, fiche de test manuelle déroulée en production, PDF à jour | 2 |

*Critère de sortie* : le test de charge passe sans machine tuée, une commande interdite est refusée, un dépassement de quota donne un message clair, et la fiche de test est déroulée sur le serveur du CREMI.

## Version 1.1 : confort pour les enseignants et les étudiants

*Objectif : une interface plus claire et des machines qui rendent des services sans configuration manuelle.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| HSV01 | Onglet « Services » d'un hôte : DHCP, DNS, web, FTP, telnet… à cocher, appliqués au redémarrage | 4 |
| FIL01 | **Fait (0.9.2).** Un seul bouton Load et un seul Save (topologie `.topo` ou session `.zip`), avec les fichiers d'exemple du serveur | 3 |
| UXS01 | Conception écrite de l'interface autour de la session, validée par l'utilisateur | 2 |
| UXS02 | **Fait.** Une session implicite par utilisateur dès la connexion, placée sur un runner seulement à son premier nœud ou chargement et libérée une fois vide ; une seule action « Reset session » à la place de « Remove all » et « Delete session » | 2 |
| UXS03 | Actions regroupées en catégories claires : Session, Nœuds, Affichage | 2 |
| CAP04 | Capture du trafic d'un **switch entier** par une prise VDE (`vde_plug`), fichier PCAP, **étude d'abord** | 4 |
| UXS04 | Mode édition et mode exécution, un seul endroit décide des contrôles actifs | 4 |
| NET01 | Couper et rebrancher un câble d'un hôte en marche (panne de lien pour les TP de routage) | 2 |
| NET02 | Points de sauvegarde d'un hôte ou d'une session : revenir à l'état d'avant une erreur | 4 |
| NET03 | Ajouter ou retirer une interface d'un hôte sans le redémarrer | 4 |
| ADM01 | **Fait (0.9.3).** Page d'administration en onglets (sessions, comptes, runners, WebSocket, journaux) | 2 |
| ADM02 | **Fait (0.9.8).** Onglet Logs de la page d'administration : vue du journal redimensionnable en hauteur (mémorisée dans le navigateur), icône sur le lien Download | 1 |
| IDS01 | **Fait (0.9.8).** Identifiants de session et de nœud sur 8 caractères hexadécimaux (au lieu de 16), partout ; collisions traitées ; exemples réécrits ; archives et sessions des versions précédentes refusées | 2 |
| ADM03 | **Fait (0.9.8).** Onglet Sessions de la page d'administration : colonne Runner (nom et ID du runner, `local`, « not placed ») et ID de session visible | 1 |
| ADM04 | **Fait (0.9.8).** Onglet Runners de la page d'administration : état d'un runner choisi (processus du runner, sessions et nœuds avec pid, mémoire et CPU, totaux), mesuré par le runner lui-même, donc aussi pour un runner distant | 3 |
| GRA02 | Plusieurs consoles flottantes dans la vue graphique | 3 |
| GRA03 | Points restants de la vue graphique : zoom au pincement, invite du shell, tooltips | 2 |
| GRA04 | Relier deux nœuds en glissant d'une prise à l'autre dans la vue graphique | 3 |
| BUGS01 (BUG06, BUG07, TOD04) | **Fait.** Trois petites corrections : catalogue illisible, message de `start.sh`, infobulle d'un contrôle désactivé | 1 |
| CTL01 | **Fait.** Suivi et contrôle complétés : la console flottante suit la vue (corrigé), l'admin qui a le contrôle peut tout faire comme l'utilisateur | 2 |
| CTL02 | **Fait (0.9.8).** Suite de CTL01 : la position et la taille de la console flottante sont suivies, elle reste ouverte au retour dans la vue graphique, l'utilisateur voit qu'un admin l'observe, bannière de contrôle courte | 2 |
| CTL03 | **Fait (0.9.8).** Suite de CTL02 : les positions des nœuds de la vue graphique deviennent des données de session (`layout.json`, dans le ZIP), le pan et le zoom sont suivis, un seul conducteur dans la vue graphique, bannières jaune et orange formulées de la même façon | 2 |
| CTL04 | **Fait (0.9.8).** Le style des liens de la vue graphique (courbes ou rectilignes) fait partie de la vue : suivi par Follow et sous contrôle, la préférence de chaque navigateur reste la sienne | 1 |
| BUG04, TOD05, TOD08 | Petites tâches indépendantes de l'annexe, à prendre au fil des creux | 1 |

*Critère de sortie* : un étudiant sans aide sait créer, lancer, arrêter et remettre à zéro sa session, et reconnaît les actions de session de celles d'un nœud.

## Version 1.2 : les postes de TP deviennent des runners

*Objectif : en salle de TP, les machines tournent sur le poste de l'étudiant ; à la maison, sur le serveur.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| SEC03 | Un runner d'étudiant n'est pas de confiance : tout ce qu'il envoie est validé et borné | 4 |
| PRN03 | Images de base : dossier partagé NFS ou téléchargement vérifié, fiche d'installation d'un poste | 3 |
| TRM01 | **Frontal texte sans serveur web** : un runner local piloté depuis le terminal (`xterm` ou `tmux` sur les consoles), solution légère pour un TP au CREMI sur une machine individuelle | 4 |

*Critère de sortie* : un étudiant enregistre son poste de TP et sa session s'y place ; un autre étudiant ne peut pas y placer la sienne. Prérequis : décision 3.

## Version 1.3 : davantage de systèmes et d'échanges

*Objectif : élargir la palette de TP (routage, autres Unix) et faciliter l'échange de fichiers.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| GST01 | Nouveaux systèmes en console série : Tiny Core, Alpine avec FRRouting, VyOS, FreeBSD ou OpenBSD (par système) | 2 |
| SHR01 | Dossier partagé entre l'hôte et la machine (9p), avec téléversement et téléchargement dans l'interface | 4 |

*Critère de sortie* : un TP de routage dynamique (OSPF ou BGP) tourne avec des machines de plusieurs systèmes, et un fichier passe de l'étudiant à sa machine sans passer par le réseau.

## Version 2.0 : graphique, conteneurs, autres plates-formes

*Objectif : accueillir des systèmes qui ne se pilotent pas en console série.*

| Code | Tâche | Difficulté |
| --- | --- | --- |
| DSP01 | Affichage graphique dans le navigateur (client VNC noVNC dans la page du serveur) pour les machines Windows ou Linux graphiques, **à long terme** | 5 |
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
