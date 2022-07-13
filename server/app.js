require('dotenv').config();

const SocketService = require("./SocketService");
const http = require('http');
const https = require('https');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { program } = require('commander');
const { Option } = require('commander');

var expressSession = require('express-session');
var bodyParser = require('body-parser')
var passport = require('passport')
var OneLoginStrategy = require('passport-openidconnect').Strategy

const baseUri = `${ process.env.OIDC_BASE_URI }`
var socketService;

program
  .addOption(new Option('-s, --secure', 'enable secure mode for http'))
  .addOption(new Option('--sslkey <file>', 'path to SSL key').default('./cert/key.pem'))
  .addOption(new Option('--sslcert <file>', 'path to SSL certificate').default('./cert/server.crt'))
  .addOption(new Option('-p, --port <number>', 'listen port').default(3000))
  .addOption(new Option('-o, --openid', 'enable openid authentication').implies({ secure: true }));

program.parse();

var options = program.opts();

var httpserv;

var app = express();

app.use(cookieParser());

// Passport requires session to persist the authentication
// so were using express-session for this example
const session = expressSession({
  secret: 'secret squirrel',
  resave: false,
  saveUninitialized: false,
  cookie: { userid: uuidv4(), maxAge: (24 * 60 * 60 * 1000)}
});

app.use(function (req, res, next) {
  console.log((new Date()) + " -- " + req.method + " " + req.url);
  next(); // let's continue with next middleware...
});

app.use(session);

if (options.openid) {
  // Configure the OpenId Connect Strategy
  // with credentials obtained from OneLogin
  passport.use(new OneLoginStrategy({
    issuer: baseUri,
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    authorizationURL: `${baseUri}/index.php/auth`,
    userInfoURL: `${baseUri}/index.php/userinfo`,
    tokenURL: `${baseUri}/index.php/token`,
    callbackURL: process.env.OIDC_REDIRECT_URI,
    passReqToCallback: true
  },
  function(req, issuer, userId, profile, accessToken, refreshToken, params, cb) {
    /*console.log('issuer:', issuer);
    console.log('userId:', userId);
    console.log('accessToken:', accessToken);
    console.log('refreshToken:', refreshToken);
    console.log('params:', params);*/

    req.session.accessToken = accessToken;
    req.session.idToken = params['id_token'];

    return cb(null, profile);
  }));

  passport.serializeUser(function(user, done) {
    done(null, user);
  });

  passport.deserializeUser(function(obj, done) {
    done(null, obj);
  });

  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Only allow authenticated users to access the /index route
  app.use('/index', checkAuthentication);

  // Initiates an authentication request with OneLogin
  // The user will be redirect to OneLogin and once authenticated
  // they will be returned to the callback handler below
  app.use('/login', passport.authenticate('openidconnect', {
    successReturnToOrRedirect: "/index",
    scope: 'profile'
  }));

  // Callback handler that OneLogin will redirect back to
  // after successfully authenticating the user
  app.use('/.oidc', passport.authenticate('openidconnect', {
    callback: true,
    successReturnToOrRedirect: '/index'
  }));
}

app.use('/index', function (req, res, next) {
  socketService.registerClient(req.session);
  next(); // let's continue with next middleware...
});

// Middleware for checking if a user has been authenticated
// via Passport and OneLogin OpenId Connect
function checkAuthentication(req,res,next){
  if(req.isAuthenticated()){
    next();
  } else{
    res.redirect("/login");
  }
}

app.use('/index/images', function (req, res, next) {
  res.send(fs.readFileSync(path.resolve('./images.json'), 'utf8'));
});

app.get('/index/state', function (req, res, next) {
  res.send(JSON.stringify(socketService.getClientState(req)));
});

var textParser = bodyParser.text();

app.post('/index/runtopo', textParser, function (req, res, next) {
  res.sendStatus(200);
  socketService.receiveTopo(req);
});

var jsonParser = bodyParser.json();

app.post('/index/registerjson', jsonParser, function (req, res, next) {
  res.sendStatus(200);
  socketService.receiveDrawJSON(req);
});

app.get('/index/stoptopo', function (req, res, next) {
  res.sendStatus(200);
  socketService.stopTopo(req);
});

app.use('/index', express.static(path.join(__dirname, 'dist')));

app.use('/', function (req, res, next) {
  res.redirect('/index');
  next();
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  console.log(err.message);
  next();
});

if (options.secure) {
  options['ssl'] = {};
  options.ssl['key'] = fs.readFileSync(path.resolve(options.sslkey), 'utf8');
  options.ssl['cert'] = fs.readFileSync(path.resolve(options.sslcert), 'utf8');
  httpserv = https.createServer(options.ssl, app);
} else {
  httpserv = http.createServer(app);
}

httpserv.listen(options.port, function () {
  console.log("Server listening : " + options.port + (options.secure ? "     (Secure mode enabled)" : "") );
  socketService = new SocketService(options.openid);
  socketService.attachServer(httpserv, session);
});
