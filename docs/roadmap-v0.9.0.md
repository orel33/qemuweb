# QemuWeb 0.9.0 — Roadmap multi-utilisateur

15 novembre 2026

## Contexte et architecture cible

QemuWeb devient une plateforme de TP réseau multi-utilisateur. Un plan de contrôle web gère les comptes et les sessions, et des runners locaux ou distants exécutent chaque session entière (QEMU + VDE). Les cinq jalons y mènent sans casser l'existant : renommage, refactoring modulaire, multi-utilisateurs, admin, puis runners.

Cette roadmap vise la version **0.9.0** (actuelle : 0.8.1). Chaque jalon est livré sous forme d'une bêta, et 0.9.0 sort une fois les critères du jalon 5 remplis.

| Jalon | Version livrée |
| --- | --- |
| 1 — Renommage session / node | 0.9.0-beta.1 |
| 2 — Refactoring modulaire | 0.9.0-beta.2 |
| 3 — Multi-utilisateurs, auth simple | 0.9.0-beta.3 |
| 4 — Rôle admin | 0.9.0-beta.4 |
| 5 — Runners et jail minimaliste | 0.9.0-beta.5 |
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
- [ ] Les archives ZIP existantes (`demo/*.zip`) se chargent toujours.

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

- [ ] Tests unitaires et d'intégration verts, plus des tests unitaires des modules `runner/` sans serveur HTTP.
- [ ] `server.js` sous 300 lignes, aucun fichier au-delà d'environ 600 lignes.
- [ ] Aucun import de `express`, `socket.io` ou `lib/` sous `runner/`, et aucun accès au runner hors de `runner/index.js`.
- [ ] La démo `demo/lan.zip` fonctionne à l'identique (test manuel).

## Jalon 3 — Multi-utilisateurs, authentification simple

Chaque étudiant se connecte avec un identifiant et un mot de passe et retrouve toujours sa session unique, avec ses machines, ses consoles et ses logs, même après une déconnexion.

**Authentification**

- Fichier `users.json` : login, hash `crypto.scrypt` (natif Node, sans dépendance), rôle.
- Script d'administration, par exemple `scripts/user.sh add alice` ou un import CSV pour une promo entière.
- Page de connexion et cookie `HttpOnly`, `Secure`, `SameSite=Lax`, signé.
- Socket.IO authentifié au handshake (`io.use`) avec le même cookie.
- Contrôle de l'en-tête `Origin` sur l'API et Socket.IO (protection CSRF).
- Authentification isolée dans un module, pour la remplacer par OpenID Connect plus tard sans toucher au reste.

**Une session par utilisateur, persistante**

- Map `login → Session`, créée à la première connexion et `owner` enregistré dans `session.json`.
- La session vit indépendamment du navigateur : fermer l'onglet ou se déconnecter ne stoppe aucune VM. Elle ne disparaît que sur suppression explicite (par l'utilisateur ou l'admin), sans expiration automatique. Un redémarrage du serveur arrête toutes les VM et vide `runtime/sessions/`, comme aujourd'hui.
- À la reconnexion, le mécanisme existant `node-snapshot` (buffer série + logs) restaure les consoles.
- Plusieurs onglets d'un même utilisateur restent possibles : ils rejoignent la même room.

**Identifiant de session** : il reste aléatoire (16 caractères hexadécimaux), jamais égal au login. Le login est stocké dans `session.json` (`owner`), une Map `login → session` sert aux recherches, et un lien lisible `runtime/users/<login> → ../sessions/<id>` aide l'admin (même mécanisme que `hostnameAliasPath`). Raisons : pas de collision entre une session supprimée et sa recréation, pas de login (e-mail, identifiant OIDC) dans les chemins de sockets limités à 107 octets, ni dans les exports ZIP ou sur les runners distants.

**Isolation logique**

- Chaque route résout `req.user → session`, puis cherche le `nodeId` uniquement dans cette session (404 sinon).
- Les 12 `io.emit` deviennent `io.to('session:<id>')`.
- Liste blanche HMP sur `/api/nodes/:nodeId/monitor` : `info …`, `system_reset`, `system_powerdown`, `stop`, `cont`, `sendkey`, `nmi`.

**Quotas** (nouvelle section `limits` de `config.json`)

- Par VM : mémoire et vCPU maximum, au lieu des 32 768 Mo et 64 vCPU actuels.
- Par session : nombre de nodes, RAM totale réservée.
- Pour le serveur : refus de démarrer une VM au-delà de la RAM disponible.

**Exposition** : le serveur reste sur `127.0.0.1`, nginx assure le TLS et le passage en WebSocket (`client_max_body_size` adapté aux imports ZIP).

**Critères de fin**

- [ ] Deux utilisateurs connectés en même temps ne voient ni ne pilotent les nodes de l'autre (test d'intégration dédié).
- [ ] Fermer le navigateur puis se reconnecter retrouve les VM en cours et leurs consoles.
- [ ] Une commande HMP hors liste blanche est refusée.
- [ ] Un dépassement de quota est refusé avec un message clair.

## Jalon 4 — Rôle admin

L'admin voit toutes les sessions en cours, peut entrer dans n'importe laquelle pour observer un étudiant, et fait le ménage en fin de TP en un clic.

**Page `/admin`** : une ligne par session.

| Colonne | Source |
| --- | --- |
| Utilisateur, date de création | `session.json` (`owner`) |
| Nodes, VM en marche | `session.nodes` |
| RAM réservée, CPU | quotas + `runner/metrics.js` |
| Dernière activité | nouvel horodatage (entrée console, appel API) |

**Actions**

- Ouvrir une session : l'admin rejoint sa room et voit consoles et logs. Lecture seule : l'admin ne tape jamais dans les consoles d'un étudiant.
- Arrêter toutes les VM d'une session, ou la supprimer (disques compris).
- Ménage groupé : sélection multiple, ou « supprimer les sessions inactives depuis X heures » (action manuelle).
- Gestion des comptes : créer, réinitialiser un mot de passe, désactiver.

**Sécurité**

- API `/api/admin/*` réservée au rôle `admin`, vérifié côté serveur.
- Journal d'audit des actions admin (qui, quoi, quand).

**Critères de fin**

- [ ] Un utilisateur non admin reçoit 403 sur toute route `/api/admin/*`.
- [ ] L'admin observe la console d'un étudiant en direct sans pouvoir y taper (entrées refusées côté serveur).
- [ ] La suppression groupée libère les processus QEMU/VDE et le répertoire `runtime/sessions/<id>/`.

## Jalon 5 — Runners local / distant et jail minimaliste

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

**Jail minimaliste**

- Le runner tourne sous un compte système dédié `qemuweb-runner` (groupe `kvm`), distinct du plan de contrôle.
- Chaque session est lancée dans un scope systemd (`systemd-run --scope -p MemoryMax=… -p CPUQuota=…`), comme garde-fou au-delà des limites QEMU.
- `runtime/` en `0700`, images de base en lecture seule.
- Le runner applique lui-même la liste blanche HMP et les quotas : il ne fait pas confiance aveuglément au plan de contrôle.
- VirtualBox reste supporté mais hors jail : ses VM sont lancées par le démon VBoxSVC, donc hors du scope systemd. Un runner annonce `qemu`, `vbox` ou les deux ; QEMU reste la priorité.
- Plus tard si besoin : un uid par session, bubblewrap ou nsjail, namespace réseau.

**Découpage conseillé**

1. 5a : interface runner formalisée au-dessus des modules `runner/` séparés au jalon 2, toujours dans le même processus.
2. 5b : runner local en processus séparé sur socket Unix, sous son compte dédié.
3. 5c : runners distants, enregistrement et placement.
4. 5d : scopes systemd et durcissement.

**Critères de fin**

- [ ] Un runner distant s'enregistre avec un jeton admin et apparaît en ligne.
- [ ] Une session placée sur un runner distant se pilote comme une session locale.
- [ ] Couper puis rétablir le réseau du runner ne tue aucune VM et l'interface se resynchronise.
- [ ] Une VM qui dépasse sa RAM est tuée par son scope sans affecter les autres sessions.

## Après le jalon 5, et décisions prises

**Pistes suivantes**

- OpenID Connect à la place de `users.json`, avec les groupes de l'IdP associés aux rôles.
- Sujets de TP : l'admin publie une archive ZIP de session comme modèle, et chaque étudiant l'instancie dans sa session.
- Un rôle enseignant distinct de l'admin, limité aux sessions de ses groupes.

**Décisions prises**

| Question | Décision |
| --- | --- |
| Redémarrage du serveur | Tout est effacé : VM arrêtées, `runtime/sessions/` vidé |
| Sessions inactives | Pas d'expiration : ménage manuel par l'admin depuis `/admin` |
| VirtualBox | Conservé aux jalons 3 à 5, sans jail ni quota cgroup ; QEMU prioritaire |
| Console admin | Lecture seule, jamais d'écriture |
| Sessions par utilisateur | Une seule, définitivement |
| Identifiant de session | Aléatoire, login dans `owner`, lien `runtime/users/<login>` |
