# QemuWeb 0.9.0 — Roadmap multi-utilisateur

15 novembre 2026

## Contexte et architecture cible

QemuWeb devient une plateforme de TP réseau multi-utilisateur. Un plan de contrôle web gère les comptes et les sessions, et des runners locaux ou distants exécutent chaque session entière (QEMU + VDE). Les six jalons y mènent sans casser l'existant : renommage, refactoring modulaire, multi-utilisateurs, admin, runners, puis durcissement applicatif et jail minimaliste.

Cette roadmap vise la version **0.9.0** (actuelle : 0.8.1). Chaque jalon est livré sous forme d'une bêta, et 0.9.0 sort une fois les critères du jalon 6 remplis.

| Jalon | Version livrée |
| --- | --- |
| 1 — Renommage session / node | 0.9.0-beta.1 |
| 2 — Refactoring modulaire | 0.9.0-beta.2 |
| 3 — Multi-utilisateurs, auth simple | 0.9.0-beta.3 |
| 4 — Rôle admin | 0.9.0-beta.4 |
| 5 — Runners local et distant | 0.9.0-beta.5 |
| 6 — Durcissement applicatif et jail minimaliste | 0.9.0-beta.6 |
| Stabilisation | 0.9.0 |

```
Navigateurs (étudiants, admin)
        │ HTTPS + WebSocket
      nginx (TLS, passage WebSocket)
        │ proxy vers 127.0.0.1
Plan de contrôle (Node.js)
  authentification, utilisateurs et rôles, une session par utilisateur,
  quotas, page /admin, placement des sessions, relais des consoles
        │                                   │
        │ socket Unix                       │ WebSocket TLS, ouvert par le runner
Runner local                          Runner distant (enregistré par l'admin, jeton)
  compte qemuweb-runner, groupe kvm     ...
  ├─ Session alice : QEMU + VDE, scope systemd
  └─ Session david : QEMU + VDE, scope systemd
```

Ce schéma montre l'architecture finale : le compte `qemuweb-runner`, les scopes systemd et les quotas n'arrivent qu'au jalon 6.

Le plan de contrôle ne lance aucune VM. Il route chaque utilisateur vers sa session, où qu'elle tourne. L'isolation entre sessions repose sur le contrôle d'accès côté serveur, la liste blanche HMP et les quotas, renforcés par le compte dédié et les scopes systemd du runner.

| Terme | Sens dans le code et l'interface |
| --- | --- |
| Utilisateur | Un compte (étudiant ou admin) |
| Session | L'espace de travail d'un utilisateur : ses nodes, son moteur, son répertoire `runtime/sessions/<id>/`. Une seule par utilisateur. |
| Node | Un élément d'une session : un host ou un switch |
| Host | Un node de type machine virtuelle (QEMU ou VirtualBox) |
| Switch | Un node de type switch VDE |
| Runner | Une machine qui exécute des sessions, locale ou distante |
| Plan de contrôle | Le serveur web Node.js : comptes, sessions, admin, relais des consoles |

## Jalon 1 — Renommage session / node

Premier jalon : un renommage pur, sans changement fonctionnel, pour que le mot « session » désigne enfin la même chose partout. Aujourd'hui, `sessionId` désigne l'instance du serveur, tandis que la Map `sessions` contient en réalité les hôtes et les switches.

| Aujourd'hui (server.js, index.html) | Après le jalon 1 |
| --- | --- |
| `sessionId`, `runtimeInstance` (instance du serveur) | `session.id`, `session.runtimeDir` |
| Map `sessions` (hôtes + switches) | `session.nodes` |
| `sessionEngine` (global) | `session.engine` |
| `/api/sessions/:sessionId`, `/api/stop/:sessionId`, `/api/reboot/…`, `/api/reset/…`, `/api/monitor/…`, `/api/hosts/:sessionId/…` | `/api/nodes/:nodeId`, `/api/nodes/:nodeId/stop`, `…/reboot`, `…/reset`, `…/monitor`, `…/config` |
| Socket.IO `select-session`, `leave-session`, `session-snapshot`, `session-error`, `sessions-changed`, `sessions-removed`, `session-renamed` | `select-node`, `leave-node`, `node-snapshot`, `node-error`, `nodes-changed`, `nodes-removed`, `node-renamed` |
| `kind: 'vm'` | `kind: 'host'` |
| `runtime/<id>/`, lien `runtime/current` | `runtime/sessions/<id>/` |
| Archive de session ZIP, `session.json` | Inchangés : ils décrivent bien une session |

Regrouper l'état global dans un objet `Session` (engine, nodes, runtimeDir, archiveBusy) se fait dès ce jalon, avec une seule instance. Le jalon 3 n'aura plus qu'à en créer une par utilisateur.

`kind: 'vm'` (environ 40 occurrences dans `server.js`) n'est pas stocké dans les archives ZIP : le renommer en `'host'` est sans impact de compatibilité.

**Documentation à mettre à jour dans le même jalon**

- `README.md` : chemin `runtime/sessions/<id>/` dans la section Configuration. Le reste emploie déjà « session » au bon sens (Save session, Load session ZIP).
- `docs/architecture.md` : la boîte « Sessions · processes and temporary files » du schéma devient « Session · nodes », et un glossaire Session / Node / Host / Switch ouvre la page.
- `AGENTS.md`, `CLAUDE.md`, `test/TESTS.md` : même vocabulaire.

**Critères de fin**

- [x] Tests unitaires et d'intégration verts (`scripts/run-tests.sh`), renommés eux aussi.
- [x] Plus aucune variable globale d'état hors de l'objet `Session`.
- [x] Les archives ZIP existantes (`demo/*.zip`) se chargent toujours.

## Jalon 2 — Refactoring modulaire

`server.js` (2 252 lignes, 85 fonctions) et `public/index.html` (2 980 lignes, dont environ 470 de CSS et 2 500 de JavaScript dans un seul `<script>`) sont découpés en modules, sans changement fonctionnel. Le découpage suit déjà la future frontière plan de contrôle / runner, ce qui allège d'autant le jalon 5.

**Serveur**

```
common/                  partagé plan de contrôle + runner
  system-config.js       catalogue config.json, profils, images
runner/
  index.js               façade : la seule API utilisée par le serveur web
  session-runtime.js     répertoire d'une session, sockets, nettoyage
  engines/
    qemu.js              arguments, lancement, arrêt, reset
    qemu-monitor.js      HMP + liste blanche
    vbox.js              VBoxManage
  network/
    vde-switch.js        vde_switch + vdeterm (node-pty)
    nics.js              ports et adresses MAC
  console/
    serial.js            socket série, buffer
    guest-hook-filter.js filtre des marqueurs de démarrage invité
  media/
    disks.js             overlays qcow2 / VDI, reset
    guest-media.js       ISO de démarrage (genisoimage)
  metrics.js             ex resource-metrics.js
  preflight.js           ex command-preflight.js (binaires, /dev/kvm)
lib/                     plan de contrôle
  session.js             classe Session, persistance de session.json
  topology.js
  session-archive.js     reste ici jusqu'au jalon 5
routes/                  routes HTTP : nodes, topologie, archives, réglages, métriques
sockets.js               événements Socket.IO
server.js                démarrage et câblage
```

**Règles de dépendance**

1. `runner/` ne dépend que de `common/` et de Node, jamais de `lib/`, d'Express ou de Socket.IO. Il signale état, logs et sortie série par un `EventEmitter`.
2. Le reste du code n'appelle le runner que via `runner/index.js`. Ses fonctions (`createNode`, `start`, `stop`, `monitor`, `attachConsole`…) deviendront les messages du protocole au jalon 5.
3. Au jalon 5, `runner/main.js` s'ajoute comme point d'entrée du processus `qemuweb-runner`, sans rien déplacer.

**Interface web**

- CSS extrait dans `public/css/app.css`.
- JavaScript en modules ES natifs (`<script type="module">`), sans framework ni bundler : `api.js`, `socket.js`, `terminal.js`, `nodes.js`, `host-settings.js`, `topology.js`, `archive.js`, à côté des fichiers déjà séparés (`monitor-terminal.js`, `session-log.js`…).
- `index.html` ne garde que la structure HTML.

**Méthode** : un commit par module extrait, tests verts à chaque commit.

**Critères de fin**

- [x] Tests unitaires et d'intégration verts, plus des tests unitaires des modules `runner/` sans serveur HTTP.
- [x] `server.js` sous 300 lignes (102), aucun fichier au-delà d'environ 600 lignes (le plus gros : `public/host-settings.js`, 498).
- [x] Aucun import de `express`, `socket.io` ou `lib/` sous `runner/`, et aucun accès au runner hors de `runner/index.js`.
- [x] La démo `demo/lan.zip` fonctionne à l'identique (test manuel).

**Écarts par rapport au découpage prévu**

- `common/` contient aussi `launch-settings.js`, `node-id.js`, `shell-quote.js` et `json-file.js` : ces helpers servent au plan de contrôle comme au runner.
- `runner/` contient des modules en plus de ceux listés (`context.js`, `catalog.js`, `host-config.js`, `launch-preview.js`, `resources.js`, `node-lifecycle.js`, `engines/child-exit.js`, `media/guest-iso.js`, `media/image-hash.js`). Le contexte du runner était à l'origine un singleton de module : il est remplacé au jalon 3 par une instance par session (`createContext()`).
- `runner/network/vde-switch.js` requiert `node-pty` (paquet, pas module natif de Node), inhérent à `vdeterm`.
- `lib/session-snapshot.js` porte la logique d'archive côté plan de contrôle, à côté de `lib/session-archive.js`.
- Interface web : modules ajoutés à ceux prévus (`app.js`, `state.js`, `workspace.js`, `node-dialogs.js`, `startup-media.js`, `general-settings.js`). Les modules ont des imports circulaires, sans effet à l'exécution tant qu'ils ne font que déclarer au chargement.
- Les commits intermédiaires du découpage serveur ne sont pas exécutables isolément (les modules sont arrivés avant le basculement de `server.js`).

## Jalon 3 — Multi-utilisateurs, authentification simple

Chaque étudiant se connecte avec un identifiant et un mot de passe et retrouve toujours sa session unique, avec ses machines, ses consoles et ses logs, même après une déconnexion.

**Authentification**

- Fichier `users.json` : login, hash `crypto.scrypt` (natif Node, sans dépendance), rôle.
- Script d'administration, par exemple `scripts/user.sh add alice` ou un import CSV pour une promo entière.
- Page de connexion et cookie `HttpOnly`, `Secure`, `SameSite=Lax`, signé.
- Socket.IO authentifié au handshake (`io.use`) avec le même cookie.
- Authentification isolée dans un module, pour la remplacer par OpenID Connect plus tard sans toucher au reste.

**Une session par utilisateur, persistante**

- Map `login → Session`, créée à la première connexion et `owner` enregistré dans `meta.json` (propre à la session vivante, jamais exporté ; `session.json` ne contient que la définition).
- La session vit indépendamment du navigateur : fermer l'onglet ou se déconnecter ne stoppe aucune VM. Elle ne disparaît que sur suppression explicite (par l'utilisateur ou l'admin), sans expiration automatique. Un redémarrage du serveur arrête toutes les VM et vide `runtime/sessions/`, comme aujourd'hui.
- À la reconnexion, le mécanisme existant `node-snapshot` (buffer série + logs) restaure les consoles.
- Plusieurs onglets d'un même utilisateur restent possibles : ils rejoignent la même room.

**Identifiant de session** : il reste aléatoire (16 caractères hexadécimaux), jamais égal au login. Le login est stocké dans `meta.json` (`owner`), une Map `login → session` sert aux recherches, et un lien lisible `runtime/users/<login> → ../sessions/<id>` aide l'admin (même mécanisme que `hostnameAliasPath`). Raisons : pas de collision entre une session supprimée et sa recréation, pas de login (e-mail, identifiant OIDC) dans les chemins de sockets limités à 107 octets, ni dans les exports ZIP ou sur les runners distants.

**Isolation logique**

- Chaque route résout `req.user → session`, puis cherche le `nodeId` uniquement dans cette session (404 sinon).
- Les 12 `io.emit` deviennent `io.to('session:<id>')`.

**Hors périmètre de ce jalon** : contrôle de l'en-tête `Origin` (protection CSRF), déconnexion révocable, mot de passe minimal, ralentissement des échecs de connexion, liste blanche HMP et quotas sont au jalon 6. Le cookie `SameSite=Lax` assure seul la protection contre les requêtes venues d'un autre site ; QemuWeb doit donc tourner sur son propre nom de domaine, pas sur un sous-domaine partagé avec des pages hébergées par les étudiants. Jusqu'à ce jalon, le Monitor accepte toute commande HMP d'une ligne et les limites de mémoire et de vCPU restent celles du code (32 768 Mo, 64 vCPU) : n'ouvrir QemuWeb qu'à des utilisateurs de confiance.

**Exposition** : le serveur reste sur `127.0.0.1`, nginx assure le TLS et le passage en WebSocket (`client_max_body_size` adapté aux imports ZIP).

**Critères de fin**

- [x] Deux utilisateurs connectés en même temps ne voient ni ne pilotent les nodes de l'autre (test d'intégration dédié).
- [x] Fermer le navigateur puis se reconnecter retrouve les VM en cours et leurs consoles.

**Écarts par rapport au plan**

- Le contexte du runner est une instance par session (`createContext()`), et `lib/session.js` ne porte plus que l'espace de travail : l'état du serveur (fichiers `server-<port>.pid` et `.session`, nettoyage) est dans `lib/server-instance.js`, et `lib/session-manager.js` fait le lien login → session + runner.
- `runtime/current` est supprimé, remplacé par `runtime/users/<login>`. Le fichier `server-<port>.session` liste désormais plusieurs identifiants de session (l'ancien format reste lu).
- Les VM VirtualBox portent l'identifiant de session dans leur nom, et l'exclusion KVM / VirtualBox vaut pour toute la machine.
- Un identifiant de node inconnu donne 404 (au lieu de 400 ou 500), sauf l'aperçu `GET /api/nodes/:id/options`.
- `session.json` ne contient que la définition de la session (identique dans le ZIP et dans `runtime/`) ; ce qui est propre à la session vivante (`owner`, `createdAt`) est dans `meta.json`.
- Ajouts : `DELETE /api/session` (suppression de sa propre session, avec le bouton de l'en-tête), `QEMUWEB_AUTH=off` (usage local explicite), `docs/deployment.md`.
- Reporté au jalon 6 : contrôle `Origin`, déconnexion révocable, politique de mot de passe, ralentissement des échecs, liste blanche HMP, quotas, jail. Un compte retiré garde sa session jusqu'à sa suppression ou au redémarrage (jalon 4 pour l'administration).

## Jalon 4 — Rôle admin

L'admin voit toutes les sessions en cours, peut observer un étudiant en train de travailler, prendre la main sur une console pour l'aider, et fait le ménage en fin de TP en un clic.

`admin` est un **rôle**, pas un type de compte à part : un admin est un utilisateur comme les autres, avec sa propre session (une seule), dans laquelle il travaille normalement (créer des hôtes, charger `lan.zip`, démarrer des VM). Le rôle ajoute la supervision, l'observation et les actions d'administration. Sa propre session apparaît dans la liste de supervision, marquée comme la sienne.

**Naviguer entre sa session et celles des étudiants**

- Trois vues : « Ma session » (l'interface normale, `/`), « Supervision » (`/admin`, le tableau de toutes les sessions, mis à jour en direct) et l'observation d'un étudiant (`/?observe=<login>`, l'interface normale en lecture seule).
- Un bandeau de couleur distincte, visible seulement en observation, porte : l'étudiant observé, « lecture seule », les flèches précédent et suivant (qui passent d'une session active à l'autre pour une tournée de la salle), la liste déroulante des sessions, « Prendre la main » et « Ma session » (« Supervision » est dans l'en-tête). On passe donc d'un étudiant à l'autre sans retourner au tableau.
- La cible est portée **par l'onglet** (paramètre d'URL gardé dans `sessionStorage`), et non par un cookie : l'interface ajoute un en-tête `X-Observe` à chaque requête, par le point d'entrée `window.fetch` qu'elle enveloppe déjà, et un paramètre d'authentification aux deux connexions Socket.IO. L'admin peut ainsi garder sa session dans un onglet et en observer une autre dans un second, sans état partagé.
- Côté serveur, une requête portant `X-Observe` n'est acceptée que d'un admin, ne crée jamais de session, ne peut être qu'un `GET` ou `HEAD` (et un login inconnu donne 404).
- Hors périmètre : un mur de consoles de plusieurs étudiants affichées en même temps.

**Page `/admin`** : une ligne par session.

| Colonne | Source |
| --- | --- |
| Utilisateur, date de création | `meta.json` (`owner`, `createdAt`) |
| Nodes, VM en marche | `session.nodes` |
| RAM réservée, CPU | mémoire des hôtes démarrés (`session.nodes`) + `runner/metrics.js` |
| Dernière activité | horodatage en mémoire, mis à jour par les requêtes API et la saisie dans les consoles de l'utilisateur (une session jamais utilisée compte depuis sa création ; l'observation d'un admin ne compte pas) |

**Observer une session (lecture seule)**

- L'admin voit la session de l'étudiant dans l'interface normale, avec **sa propre disposition** : pour ses requêtes en lecture, le serveur lui fait voir la session choisie à la place de la sienne, et refuse tout ce qui n'est pas un `GET`. L'interface se met en mode observation (bandeau, actions désactivées).
- Il reçoit en direct la sortie des consoles de l'étudiant, c'est-à-dire l'écho de sa saisie et les réponses (l'invité renvoie tout sur le port série), plus l'historique (les 256 Ko les plus récents de chaque console) et les logs. Un mot de passe saisi, sans écho dans l'invité, reste invisible.
- Saisie, effacement (Clear) et redimensionnement des consoles sont refusés **côté serveur** pour un observateur : ils agiraient sur l'écran de l'étudiant.
- L'interface de l'étudiant signale le node qu'il sélectionne, et celle de l'admin le suit.
- Hors périmètre : reproduire à l'identique la disposition (panneaux, onglets, positions du graphe) du navigateur de l'étudiant, qui n'existe que chez lui.

**Prendre la main (dernière étape du jalon)**

- Bouton explicite sur un node observé. Les commandes de l'admin passent par le même port série : l'étudiant les voit, avec leurs réponses, comme s'il les avait tapées. Le flux ne dit pas qui tape ; un bandeau, envoyé par un événement distinct du flux série, l'indique des deux côtés.
- **Verrou exclusif** : le clavier de l'étudiant est bloqué sur ce node tant que l'admin a la main. Elle est rendue par l'admin, à sa déconnexion, ou après 10 minutes sans saisie.
- Le journal d'audit note le début et la fin de la prise de contrôle et le node concerné. Le texte tapé n'est pas enregistré.
- Hors périmètre : une seconde console indépendante dans l'invité (réseau de TP isolé, images à modifier).

**Autres actions**

- Arrêter toutes les VM d'une session (sans supprimer ses nodes), ou la supprimer (disques compris). Les navigateurs de l'utilisateur sont rechargés.
- Ménage groupé : sélection multiple des sessions, avec confirmation qui liste les sessions concernées ; la session de l'admin qui la lance est exclue. La colonne « Dernière activité » permet de repérer les sessions abandonnées (pas de suppression automatique ni de filtre par durée).
- Gestion des comptes : créer (identifiant, mot de passe, rôle), réinitialiser un mot de passe, désactiver et réactiver. Un compte désactivé (`disabled` dans `users.json`, et `scripts/user.sh disable|enable`) ne peut plus se connecter et ses cookies sont refusés aussitôt ; sa session reste jusqu'à ce qu'un admin la supprime. Un admin ne peut ni se désactiver ni changer son propre rôle depuis la page.

**Sécurité**

- API `/api/admin/*` réservée au rôle `admin`, vérifié côté serveur : un seul routeur dont le premier maillon est le contrôle du rôle (même un chemin inconnu répond 403 à un non-admin), monté avant l'ouverture de la session de l'utilisateur.
- Journal d'audit des actions admin : fichier `admin.log` en JSON lignes, dans le répertoire `logs/` à la racine du dépôt (ignoré par git ; `QEMUWEB_LOG_DIR` déplace le répertoire, par exemple vers `/var/log/qemuweb`). Chaque ligne note l'heure, l'admin, l'action, la cible et le résultat, y compris l'ouverture d'une observation, la prise de contrôle et les changements de comptes. Jamais de mot de passe.
- Journal d'activité des utilisateurs : fichier `users.log` dans le même répertoire, ajouté après le jalon (petit commit séparé). Il note, pour tous les comptes, les événements d'utilisation sans aucun contenu : connexion, déconnexion, échec de connexion, création et suppression de session, création, démarrage, arrêt et suppression de nodes, archives chargées ou sauvegardées. `admin.log` ne contient que ce qui est propre au rôle admin (agir sur la session d'un autre, gérer les comptes).
- Avec `QEMUWEB_AUTH=off`, l'utilisateur local est admin : `/admin` est ouvert à qui atteint le serveur, avec le même avertissement qu'ailleurs.

**Découpage conseillé**

1. 4a : contrôle du rôle et routeur `/api/admin/*`, champ `disabled`, module d'audit, horodatage d'activité, arrêt de toutes les VM dans la façade du runner.
2. 4b : API d'administration : liste des sessions, arrêt, suppression, ménage groupé, gestion des comptes, le tout journalisé.
3. 4c : observation en lecture seule (en-tête `X-Observe` et session substituée pour les requêtes en lecture, sockets en observation, suivi du node de l'étudiant).
4. 4d : page `/admin`, mode observation de l'interface et navigation entre les sessions (bandeau, précédent et suivant, liste déroulante).
5. 4e : prise de contrôle avec verrou exclusif, tests, documentation.

**Critères de fin**

- [ ] Un utilisateur non admin reçoit 403 sur toute route `/api/admin/*`.
- [ ] L'admin observe la console d'un étudiant en direct sans pouvoir y taper, l'effacer ni la redimensionner (refusé côté serveur).
- [ ] La suppression groupée libère les processus QEMU/VDE et le répertoire `runtime/sessions/<id>/`.
- [ ] En prise de contrôle, le clavier de l'étudiant est bloqué, il voit les commandes et leurs réponses, et la main est rendue à la déconnexion de l'admin.
- [ ] Chaque action d'administration laisse une ligne dans le journal d'audit.

## Jalon 5 — Runners local / distant

L'exécution des sessions sort du serveur web vers des runners, sur le modèle de gitlab-runner : c'est le runner qui se connecte au plan de contrôle, avec un jeton délivré par l'admin. Une session entière (QEMU + VDE) tourne sur un seul runner pendant toute sa vie.

**Enregistrement, comme gitlab-runner**

1. L'admin crée un jeton d'enregistrement dans `/admin/runners` (usage unique, durée limitée).
2. Sur la machine runner : `qemuweb-runner register --url https://qemuweb.example --token <jeton>`.
3. Le plan de contrôle renvoie un jeton d'authentification propre au runner, stocké dans `/etc/qemuweb-runner/config.toml` avec ses limites (RAM, vCPU, sessions max).
4. `qemuweb-runner run` (unité systemd) ouvre une connexion WebSocket TLS **sortante** et la maintient. Aucun port entrant n'est nécessaire côté runner, ce qui marche derrière un NAT ou un pare-feu de salle de TP.
5. Le runner annonce sa capacité : RAM, vCPU, moteurs (`qemu`, `vbox`), images disponibles avec leur empreinte.

**Protocole runner** (un seul WebSocket multiplexé)

- Commandes : créer ou supprimer une session, créer ou configurer un node, start, stop, reset, monitor.
- Flux : console série, terminal de switch, logs, changements d'état, métriques.
- Fichiers : import et export d'archives ZIP en flux.
- Le runner local utilise le même protocole sur un socket Unix, enregistré automatiquement.
- Le runner est la source de vérité sur l'état des nodes : après une coupure, il se reconnecte et resynchronise, et les VM n'ont pas cessé de tourner.

**Placement** : à la création d'une session, le plan de contrôle choisit un runner en ligne qui a le moteur, les images et la RAM nécessaires. Pas de migration de session entre runners.

**Administration des runners** : liste avec état (en ligne, vu pour la dernière fois), capacité et charge ; mettre en pause (drain : plus de nouvelles sessions) ; révoquer le jeton.

**Sécurité** : la jail minimaliste (compte dédié, scopes systemd), la liste blanche HMP et les quotas arrivent au jalon 6. Jusque-là, le runner tourne sous le compte qui le lance : choisir un compte sans privilège, jamais root, et réserver les runners distants à des machines de confiance.

**Découpage conseillé**

1. 5a : interface runner formalisée au-dessus des modules `runner/` séparés au jalon 2, toujours dans le même processus.
2. 5b : runner local en processus séparé sur socket Unix.
3. 5c : runners distants, enregistrement et placement.

**Critères de fin**

- [ ] Un runner distant s'enregistre avec un jeton admin et apparaît en ligne.
- [ ] Une session placée sur un runner distant se pilote comme une session locale.
- [ ] Couper puis rétablir le réseau du runner ne tue aucune VM et l'interface se resynchronise.

## Jalon 6 — Durcissement applicatif et jail minimaliste

Les protections applicatives et la jail du runner sont regroupées ici, après les runners, pour être appliquées par le runner lui-même : il ne fait pas confiance aveuglément au plan de contrôle, y compris quand il est distant. Avant ce jalon, QemuWeb ne doit être ouvert qu'à des utilisateurs de confiance.

**Comptes**

- Mot de passe : longueur minimale de 8 caractères imposée par `scripts/user.sh` et par la réinitialisation depuis `/admin`, avec une option explicite `--allow-weak` pour les comptes de test.
- Ralentissement des échecs de connexion (par login et par adresse IP), sans verrouillage définitif.

**Sessions web**

- Contrôle de l'en-tête `Origin` sur l'API (requêtes qui modifient l'état) et sur le branchement Socket.IO, avec une liste d'origines autorisées pour nginx. Il protège contre les sous-domaines voisins et les anciens navigateurs, que `SameSite=Lax` ne couvre pas. À traiter : un `Origin` absent sur le branchement Socket.IO (les requêtes GET de repli du navigateur n'en envoient pas).
- Déconnexion révocable : le cookie signé est aujourd'hui sans état côté serveur, donc une copie reste valable jusqu'à son expiration. Prévoir une liste de sessions web côté serveur, ou la rotation du secret.

**Liste blanche HMP**

- `/api/nodes/:nodeId/monitor` n'accepte que `info …`, `system_reset`, `system_powerdown`, `stop`, `cont`, `sendkey`, `nmi`. Le runner la vérifie lui-même.

**Quotas** (nouvelle section `limits` de `config.json`, validée par `common/system-config.js`)

- Par VM : mémoire et vCPU maximum, au lieu des 32 768 Mo et 64 vCPU codés en dur dans `common/launch-settings.js` ; les champs de l'interface en dérivent.
- Par session : nombre de nodes, RAM totale des hôtes démarrés.
- Pour le serveur ou le runner : refus de démarrer une VM au-delà de la RAM disponible.
- Appliqués par le runner, avec un message d'erreur clair. Les limites propres à un runner distant restent dans son `config.toml` (jalon 5).

**Jail minimaliste**

- Le runner tourne sous un compte système dédié `qemuweb-runner` (groupe `kvm`), distinct du plan de contrôle.
- Chaque session est lancée dans un scope systemd (`systemd-run --scope -p MemoryMax=… -p CPUQuota=…`), comme garde-fou au-delà des limites QEMU.
- `runtime/` en `0700`, images de base en lecture seule.
- VirtualBox reste supporté mais hors jail : ses VM sont lancées par le démon VBoxSVC, donc hors du scope systemd. Un runner annonce `qemu`, `vbox` ou les deux ; QEMU reste la priorité.
- Plus tard si besoin : un uid par session, bubblewrap ou nsjail, namespace réseau.

**Critères de fin**

- [ ] Une commande HMP hors liste blanche est refusée, y compris sur un runner distant.
- [ ] Un dépassement de quota (VM, session ou serveur) est refusé avec un message clair.
- [ ] Un mot de passe trop court est refusé par `scripts/user.sh`, sauf avec `--allow-weak`.
- [ ] Les échecs de connexion répétés sont ralentis.
- [ ] Une requête d'écriture ou un branchement Socket.IO venant d'une origine non autorisée est refusé.
- [ ] Après une déconnexion, l'ancien cookie n'ouvre plus de session.
- [ ] Le runner local tourne sous le compte `qemuweb-runner`, `runtime/` est en `0700` et les images de base sont en lecture seule.
- [ ] Une VM qui dépasse sa RAM est tuée par son scope sans affecter les autres sessions.

## Stabilisation (0.9.0)

À la sortie de 0.9.0, les formats de fichiers repartent à zéro : plus aucun numéro de version hérité des bêtas. Pendant les bêtas, aucun `schemaVersion` n'est incrémenté : les formats changent librement. La compatibilité avec un ancien format n'est pas conservée non plus (voir `AGENTS.md`).

- Remettre `schemaVersion` à **1** partout : `session.json` (4 aujourd'hui), `host.json` (3), `switch.json` (2) et `config.json` (4). `meta.json` et `users.json` sont déjà à 1. Cela touche le code (`lib/session.js`, `runner/host-config.js`, `runner/session-runtime.js`, `lib/session-snapshot.js`, `lib/server-instance.js`, `common/system-config.js`), les tests, `config.json` et la documentation.
- Réécrire les 5 archives de `demo/` avec ces valeurs (elles contiennent `session.json`, `host.json` et `switch.json`).
- Renommer le fichier téléchargé `qemuweb-session-v4.zip` en `qemuweb-session.zip` (`routes/archives.js`, `public/archive.js`).
- À partir de 0.9.0, tout changement de format incrémente le numéro et s'accompagne d'une décision explicite sur la compatibilité.

## Après le jalon 6, et décisions prises

**Pistes suivantes**

- OpenID Connect à la place de `users.json`, avec les groupes de l'IdP associés aux rôles.
- Sujets de TP : l'admin publie une archive ZIP de session comme modèle, et chaque étudiant l'instancie dans sa session.
- Un rôle enseignant distinct de l'admin, limité aux sessions de ses groupes.

**Décisions prises**

| Question | Décision |
| --- | --- |
| Redémarrage du serveur | Tout est effacé : VM arrêtées, `runtime/sessions/` vidé, utilisateurs déconnectés (nouvelle clé de signature des cookies) |
| Sessions inactives | Pas d'expiration : ménage manuel par l'admin depuis `/admin` |
| VirtualBox | Conservé aux jalons 3 à 6, sans jail ni quota cgroup ; QEMU prioritaire |
| Console admin | Lecture seule ; écriture seulement après une prise de contrôle explicite (verrou exclusif, visible par l'étudiant, journalisée) |
| Sessions par utilisateur | Une seule, définitivement |
| Identifiant de session | Aléatoire, login dans `owner`, lien `runtime/users/<login>` |
| Numéros `schemaVersion` | Jamais incrémentés pendant les bêtas ; remis à 1 à la sortie de 0.9.0 (section Stabilisation) |
| Sécurité (mot de passe minimal, quotas, liste blanche HMP, jail du runner) | Jalon 6, après les runners ; jusque-là, utilisateurs de confiance uniquement |
