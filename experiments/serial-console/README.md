# Test de console série Alpine : QEMU/KVM et VirtualBox

Ce prototype démarre la même image live Alpine virt avec QEMU ou VirtualBox et relaie ttyS0 vers xterm.js dans un serveur web local. Le test est volontairement sans disque persistant et sans carte réseau. L’ISO est téléchargée dans `runtime/` et vérifiée avec le SHA-256 publié par Alpine.

QEMU utilise KVM quand `/dev/kvm` est accessible ; sinon il retombe sur TCG. Le moteur actif apparaît dans l’état de la page. Le wiki Alpine indique que l’image ISO `virt` inclut la console série dans sa configuration par défaut.

Depuis la racine du dépôt :

```sh
cd experiments/serial-console
bash prepare.sh
npm install
npm start
```

Ouvrir <http://127.0.0.1:3002>, choisir QEMU ou VirtualBox puis démarrer. Se connecter comme `root` ; l’image live n’a pas de mot de passe root par défaut. La session est éphémère : un redémarrage repart de l’ISO.

Arrêter la VM avec le bouton de la page et le serveur avec Ctrl+C. Les fichiers téléchargés restent dans `runtime/`, ignoré par Git.
