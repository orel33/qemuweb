# Fichiers conservés localement hors de GitHub

Ces deux images existaient dans `images/` mais ne sont pas incluses dans la branche de sauvegarde GitHub : leur taille dépasse la limite d’un fichier Git standard et l’environnement ne dispose pas de Git LFS. Les fichiers restent intacts sur cette machine.

| Fichier | Taille | SHA-256 |
| --- | ---: | --- |
| `images/debian11.img` | 3 482 635 264 octets | `65c034cd5429188fdbe93725f9edb179d4416f5ca4ab9b2a71e1cdebb9cf09a0` |
| `images/debian11.tgz` | 421 570 524 octets | `682d93c000da382a308c3f8479121e4f323dfa1377e84de3d195cad829e5057b` |

Ces fichiers ne seront pas présents dans le nouveau `main`. Pour les conserver hors de cette machine, il faudra choisir un stockage d’images adapté ou configurer Git LFS pour les formats qu’il peut accepter.
