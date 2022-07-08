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

      console.log("Client with id " + userid + " connect to the machine '" + socket.handshake.query.name + "' via socket ", socket.id);
      client.requestTerm(name, type, socket);
      /*if (client.activeSessions < 1) {
        client.initSession(socket);
      } else {
        client.requestNewSession(socket);
      }*/

      socket.on("disconnect", () => {
        console.log("Client with id " + userid + " disconnected from socket ", socket.id);
        client.attachedSessions--;
      });

      socket.on('resize', (data) => {
        console.log((new Date()) + " -- resize terminal col=" + data.col + ", row=" + data.row);
        var pty = type == "host" ? client.ptysHost[name] : client.ptysSwitch[name];
        pty.ptyProcess.resize(data.col, data.row);
      });

      // Attach any event listeners which runs if any event is triggered from socket.io client
      // For now, we are only adding "input" event, where client sends the strings you type on terminal UI.
      socket.on("input", (input) => {
        //Runs this event function socket receives "input" events from socket.io client
        var pty = type == "host" ? client.ptysHost[name] : client.ptysSwitch[name];
        pty.write(input);
      });
    });
  }

  receiveTopo(request) {
    var userid = this.openid ? request.session.passport.user.id : request.session.cookie.userid;
    console.log("Run topology \n" + request.body + "for client ", userid);
    this.clients[userid].initSession(request.body);
  }
}

module.exports = SocketService;
