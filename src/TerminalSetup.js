import { TerminalUI } from "@/TerminalUI";
import io from "socket.io-client";

export class TerminalSetup {
    connectToSocket(serverAddr) {
        return new Promise(res => {
            const socket = io(serverAddr);
            res(socket);
        });
    }

    startTerminal(container, socket) {
        const terminal = new TerminalUI(socket);
        terminal.attachTo(container);
        console.log("startTerminal");
        terminal.startListening();
    }

    start() {
        var containers = document.getElementsByClassName("terminal-container");

        if (containers == undefined || containers.length < 1) {
            console.log("Pas de container pour le terminal trouvé");
            return;
        }
        for (let container of containers) {
            console.log("connect on " + this.serverAddress)
            this.connectToSocket(this.serverAddress).then(socket => {
                this.startTerminal(container, socket);
            });
        }
    }
}