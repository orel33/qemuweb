# Aperçu hors ligne de QemuWeb

Depuis la racine du dépôt, avec les dépendances du frontend déjà installées :

```sh
cd frontend
VUE_APP_OFFLINE_PREVIEW=true ./node_modules/.bin/vue-cli-service build --dest ../preview/dist
cd ..
docker build -t qemuweb-preview preview/
docker run -d --name qemuweb-preview -p 127.0.0.1:3001:80 qemuweb-preview
```

Ouvrir http://localhost:3001/. Cette image ne contient que les fichiers statiques de l'interface. Le mode aperçu désactive les appels au backend, les consoles et l'exécution des VM. L'import/export des dessins reste disponible localement dans le navigateur.
