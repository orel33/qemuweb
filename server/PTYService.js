const os = require("os");
const pty = require("node-pty");

class PTY {
  constructor(type) {
    this.shell = os.platform() === "win32" ? "cmd.exe" : "bash";
    this.ptyProcess = null;
    this.type = type;
    this.connected = false;
    this.killed = false;
    // Initialize PTY process.
    this.startPtyProcess();
  }

  /**
   * Spawn an instance of pty with a selected shell.
   */
  startPtyProcess() {
    this.ptyProcess = pty.spawn(this.shell, [], {
      name: "xterm-color",
      cwd: process.env.HOME, // Which path should terminal start
      env: process.env // Pass environment variables
    });
  }

  killPtyProcess() {
    this.ptyProcess.kill();
    this.killed = true;
  }

  getState() {
    return { connected: this.connected, killed: this.killed };
  }

  bindTerminal(socket) {
    // Add a "data" event listener.
    this.ptyProcess.on("data", data => {
      // Whenever terminal generates any data, send that output to socket.io client to display on UI
      this.sendToClient(socket, data);
      this.connected = true;
    });
    //TO DO OnExit, send event to client via websocket to close xtermjs
  }

  /**
   * Use this function to send in the input to Pseudo Terminal process.
   * @param {*} data Input from user like command sent from terminal UI
   */
  write(data) {
    this.ptyProcess.write(data);
  }

  sendToClient(socket, data) {
    // Emit data to socket.io client in an event "output"
    socket.emit("output", data);
  }

  sendCommand(command) {
    this.write(command + "\n");
  }
}

module.exports = PTY;
