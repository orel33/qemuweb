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

Usage: `node app.js [options]`

Options:
```
    -s, --secure         enable secure mode for http
    --sslkey <file>      path to SSL key (default: "./cert/key.pem")
    --sslcert <file>     path to SSL certificate (default: "./cert/server.crt")
    -p, --port <number>  listen port (default: 3000)
    -o, --openid         enable openid authentication
    -h, --help           display help for command
```
#### Exemples

- `node app.js` run a server listening http connections on port 3000. Perfect for **local testing** but you can also use it to deploy your server through a simple way.
- `node app.js --secure` run a server in with secure http listening https connections. To secure the connections, the server use by default self-signed certificate located in the [cert](https://gitlab.emi.u-bordeaux.fr/qemunet/qemuweb/-/tree/main/server/cert) folder.
    - You can modify the certificate and put the one you want instead, for instance:
        - `node app.js --secure --sslkey /path/to/my/supercert/key.pem --sslcert /path/to/my/supercert/server.crt`
- `node app.js --openid` run a server that will force the users to authenticate with OpenId before accessing the page.
    - :lock: If you don't put `--secure` option with `--openid`, the secure mode will be enable anyway because the OpenId server only accept https requests. 
- `node app.js -s -o -p 443` run a server protected by OpenId authentication and listening https connections on port 443. This is the command run on the qemuweb-v0 server at CREMI.

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


