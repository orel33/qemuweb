require('dotenv').config();

const SocketService = require("./SocketService");
const http = require('http');
const https = require('https');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

const { program } = require('commander');

var expressSession = require('express-session');
var passport = require('passport')
var OneLoginStrategy = require('passport-openidconnect').Strategy

const baseUri = `${ process.env.OIDC_BASE_URI }`

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

  console.log('issuer:', issuer);
  console.log('userId:', userId);
  console.log('accessToken:', accessToken);
  console.log('refreshToken:', refreshToken);
  console.log('params:', params);

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

program
  .option('-s, --secure', 'enable secure mode for http')
  .option('--sslkey <file>', 'path to SSL key', './cert/key.pem')
  .option('--sslcert <file>', 'path to SSL certificate', './cert/server.crt')
  .option('-p, --port <number>', 'listen port', 3000);

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
  saveUninitialized: true
});
app.use(session);

app.use(function (req, res, next) {
  console.log((new Date().getTime()) + " -- " + req.method + " " + req.url);
  next(); // let's continue with next middleware...
});

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Middleware for checking if a user has been authenticated
// via Passport and OneLogin OpenId Connect
function checkAuthentication(req,res,next){
  if(req.isAuthenticated()){
    next();
  } else{
    res.redirect("/login");
  }
}

// Only allow authenticated users to access the / route
app.use('/index', checkAuthentication);

app.use('/index', express.static(path.join(__dirname, 'dist')));

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
}))

app.use('/', function (req, res, next) {
  res.redirect('/index');
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
  const socketService = new SocketService();
  socketService.attachServer(httpserv, session);
});
