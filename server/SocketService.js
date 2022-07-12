// Manage Socket.IO server
const socketIO = require("socket.io");
const Client = require("./Client");

class SocketService {
  constructor(openIdEnabled) {
    this.clients = {}; // Map<UserID, Client>
    this.openid = openIdEnabled;
  }

  registerClient(session) {
    var userid = this.openid ? session.passport.user.id : session.cookie.userid;

    if (this.clients[userid] == undefined) {
      console.log("New client registered: " + userid);
      this.clients[userid] = new Client(userid);
    }
    this.setTimerToDeath(userid);
  }

  attachServer(server, session) {
    if (!server) {
      throw new Error("Server not found...");
    }

    const io = socketIO(server);
    const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
    io.use(wrap(session));
    console.log("Created socket server. Waiting for client connection.");
    // "connection" event happens when any client connects to this io instance.
    io.on("connection", socket => {
      var userid = this.openid ? socket.request.session.passport.user.id : socket.request.session.cookie.userid;
      var name = socket.handshake.query.name;
      var type = socket.handshake.query.type;
      var client = this.clients[userid];

      this.setTimerToDeath(userid);

      console.log("Client with id " + userid + " connect to the machine '" + socket.handshake.query.name + "' via socket ", socket.id);
      client.requestTerm(name, type, socket);

      socket.on("disconnect", () => {
        console.log("Client with id " + userid + " disconnected from socket ", socket.id);
      });

      socket.on('resize', (data) => {
        this.setTimerToDeath(userid);
        var pty = type == "host" ? client.ptysHost[name] : client.ptysSwitch[name];
        pty.ptyProcess.resize(data.col, data.row);
      });

      // Adding "input" event, where client sends the strings you type on terminal UI.
      socket.on("input", (input) => {
        //Runs this event function socket receives "input" events from socket.io client
        this.setTimerToDeath(userid);
        var pty = type == "host" ? client.ptysHost[name] : client.ptysSwitch[name];
        pty.write(input);
      });
    });
  }

  receiveTopo(request) {
    var userid = this.openid ? request.session.passport.user.id : request.session.cookie.userid;
    this.setTimerToDeath(userid);
    console.log("Run topology \n" + request.body + "for client ", userid);
    this.clients[userid].initSession(request.body);
  }

  stopTopo(request) {
    var userid = this.openid ? request.session.passport.user.id : request.session.cookie.userid;
    this.setTimerToDeath(userid);
    console.log("Stop topology for client ", userid);
    this.clients[userid].killQemunetSession();
  }

  getClientState(request) {
    var userid = this.openid ? request.session.passport.user.id : request.session.cookie.userid;
    this.setTimerToDeath(userid);
    return this.clients[userid].getState();
  }

  setTimerToDeath(userid) {
    var client = this.clients[userid];
    if (!client) { return; }
    if (client.timeToDie != null) {
        clearTimeout(client.timeToDie);
    }
    client.timeToDie = setTimeout((function() {
        client.killQemunetSession();
        client.killSession();
        client.ptyControl.killPtyProcess();
        delete this.clients[userid];
        console.log("CLIENT " + userid + " has succefully been finished and doesn't exist anymore");
    }).bind(this), 1000 * 60 * 60 * 3); // Executed after 3 hours
  }
}

module.exports = SocketService;
