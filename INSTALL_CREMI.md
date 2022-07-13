# QemuWeb

## Requires
- Node : version 10.13.0 or newer

Install with `sudo apt install node`

- npm : version 6.14.17 or newer

Install with `sudo apt install npm`

- Firejail

Install with `sudo apt install firejail`

- Tmux

Install with `sudo apt install tmux`

## Install

`npm install` doesn't work on qemuweb-v0 machine because it connects to a mirror that is a local packages repository at CREMI and this local repository doesn't have all the dependancies for the project. You have to construct the node_modules folders on an other machine and copy those folders manually.

#### On your PC
```
git clone git@gitlab.emi.u-bordeaux.fr:qemunet/qemuweb.git
```
```
cd qemuweb
npm install
scp -r node_modules root@qemuweb:/root/srv/qemuweb/

cd qemuweb/server
npm install
scp -r node_modules root@qemuweb:/root/srv/qemuweb/server/
```

#### On qemuweb-V0 machine at CREMI
If your PC and qemuweb-v0 have a different version of Node or npm, you have to `rebuild` the modules.
```
git clone git@gitlab.emi.u-bordeaux.fr:qemunet/qemuweb.git
```
```
cd qemuweb
npm rebuild

cd qemuweb/server
npm rebuild
```

## Run

```
cd qemuweb/server
node app.js -s -o -p 443
```
Then open https://qemuweb.emi.u-bordeaux.fr on a browser.

## Options

You can change the parameters of the server with options.

Usage: ```node app.js [options]```

Options:
```
    -s, --secure         enable secure mode for http
    --sslkey <file>      path to SSL key (default: "./cert/key.pem")
    --sslcert <file>     path to SSL certificate (default: "./cert/server.crt")
    -p, --port <number>  listen port (default: 3000)
    -o, --openid         enable openid authentication
    -h, --help           display help for command
```



