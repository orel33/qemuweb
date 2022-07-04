// Manage Socket.IO server
const socketIO = require("socket.io");
const Client = require("./Client");

class SocketService {
  constructor() {
    //this.sockets = {};
    this.clients = {}; // Map<UserID, Client>
    //this.ptys = {};
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
      // Get cookies from the session
      var userid = socket.request.session.passport.user.id;

      console.log("Client with id " + userid + " connect to socket ", socket.id);

      if (this.clients[userid] == undefined || this.clients[userid] == null) {
        // Client unknown
        this.clients[userid] = new Client(socket, userid);
      } else {
        // Client known
        this.clients[userid].requestNewSession(socket);
      }

      socket.on("disconnect", () => {
        console.log("Client with id " + userid + " disconnected from socket ", socket.id);
        this.clients[userid].attachedSessions--;
      });

      socket.on('resize', (data) => {
        console.log((new Date()) + " -- resize terminal col=" + data.col + ", row=" + data.row);
        var currClient =  this.clients[userid];
        currClient.ptys[socket.id].ptyProcess.resize(data.col, data.row);
      });

      // Attach any event listeners which runs if any event is triggered from socket.io client
      // For now, we are only adding "input" event, where client sends the strings you type on terminal UI.
      socket.on("input", (input) => {
        //Runs this event function socket receives "input" events from socket.io client
        var currClient =  this.clients[userid];
        currClient.ptys[socket.id].write(input); 
      });
    });
  }
}

module.exports = SocketService;
