import { Terminal } from "xterm";
import { FitAddon } from 'xterm-addon-fit';
import "xterm/css/xterm.css";

export class TerminalUI {
  constructor() {
    this.xterm = new Terminal();
    this.fitAddon = new FitAddon();

    /** You can make your terminals colorful */
    this.xterm.setOption("theme", {
      background: "#202B33",
      foreground: "#F5F8FA"
    });
  }

  /**
   * Attach event listeners for terminal UI and socket.io client
   */
  startListening(socket) {
    this.socket = socket;
    this.xterm.onData(data => this.sendInput(data));
    this.socket.on("output", data => {
      // When there is data from PTY on server, print that on Terminal.
      this.write(data);
    });
    this.socket.on("exit", () => {
      this.write("\n***\nThe machine has exited\n***");
    });
    this.sendInput("\n");
  }

  /**
   * Print something to terminal UI.
   */
  write(text) {
    this.xterm.write(text);
  }

  /**
   * Utility function to print new line on terminal.
   */
  prompt() {
    this.xterm.write(`\r\n$ `);
  }

  /**
   * Send whatever you type in Terminal UI to PTY process in server.
   * @param {*} input Input to send to server
   */
  sendInput(input) {
    this.socket.emit("input", input);
  }

  /**
   *
   * @param {HTMLElement} container HTMLElement where xterm can attach terminal ui instance.
   */
  attachTo(container) {
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.open(container);
    
    const self = this;
    container.parentElement.addEventListener('resize', function () {
      self.fitAddon.fit();
      self.socket.emit('resize', { col: self.xterm.cols, row: self.xterm.rows } );
    });

    // Default text to display on terminal.
    this.xterm.write("Terminal Connected");
    this.xterm.write("");
    this.prompt();
  }

  clear() {
    this.xterm.clear();
  }
}