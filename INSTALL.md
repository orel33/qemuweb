# QemuWeb

## Requires
- Node : version 10.13.0 or newer

Install with ```sudo apt install node```

- npm : version 6.14.17 or newer

Install with ```sudo apt install npm```

- Firejail

Install with ```sudo apt install firejail```

- Tmux

Install with ```sudo apt install tmux```

## Install

```
cd qemuweb
npm install
npm run build

cd qemuweb/server
npm install
```

## Run

```
cd qemuweb/server
node app.js
```
Then open http://localhost:3000 on a browser.

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



