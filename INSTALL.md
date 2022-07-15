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

## OpenId

If you use the --openid option, the server will ask you to authenticate via OpenId before you can access the page.
The setup of the OpenId server is made in [app.js](https://gitlab.emi.u-bordeaux.fr/qemunet/qemuweb/-/blob/main/server/app.js).
Some parameters are hard-coded and others are in [.env](https://gitlab.emi.u-bordeaux.fr/qemunet/qemuweb/-/blob/main/server/.env) configuration file.

    - In .env, you can find:
        - OIDC_BASE_URI: The base URI for your authentication OpenId server
        - OIDC_CLIENT_ID and OIDC_CLIENT_SECRET : Your credentials that allow you to request the OpenId server
        - OIDC_REDIRECT_URI: The URI that the OpenId server calls when the client has successfully authenticate (=callback URI)
        - PORT : The port through which you request the server
    - In app.js, you can find :
        - authorizationURL: The URL which is requested when your server ask for an authentication to the OpenId server
        - userInfoURL: The URL which is requested when your server ask for user info to the OpenId server
        - authorizationURL: The URL which is requested when your server ask for the connection token to the OpenId server

If you want to change OIDC_REDIRECT_URI parameter, you have also to add a callback handler for this specific route as is done for '/.oidc' in app.js .


