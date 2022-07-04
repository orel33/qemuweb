const os = require("os");
const pty = require("node-pty");

class PTY {
  constructor(socket) {
    this.shell = os.platform() === "win32" ? "cmd.exe" : "bash";
    this.ptyProcess = null;
    this.socket = socket;

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

    // Add a "data" event listener.
    this.ptyProcess.on("data", data => {
      // Whenever terminal generates any data, send that output to socket.io client to display on UI
      this.sendToClient(data);
    });
  }

  createSession(userid, sessionCount) {
    const sessionId = userid + "_" + sessionCount;
    this.sendCommand("tmux ls | grep " + userid + " && tmux attach -t " + sessionId + " || tmux new -s " + sessionId);
  }

  attachSession(userid, sessionCount) {
    const sessionId = userid + "_" + sessionCount;
    this.sendCommand("tmux attach -t " + sessionId);
  }

  /**
   * Use this function to send in the input to Pseudo Terminal process.
   * @param {*} data Input from user like command sent from terminal UI
   */
  write(data) {
    this.ptyProcess.write(data);
  }

  sendToClient(data) {
    // Emit data to socket.io client in an event "output"
    this.socket.emit("output", data);
  }

  sendCommand(command) {
    this.write(command + "\n");
  }
}

module.exports = PTY;
