import { TerminalUI } from "@/TerminalUI";
import io from "socket.io-client";
import $ from 'jquery';
import jquery_ui from '@/jquery-ui/jquery-ui.js';

var termSetup = { 
    connectToSocket(serverAddr) {
        return new Promise(res => {
            const socket = io(serverAddr);
            res(socket);
        });
    },
    startTerminal(container, socket) {
        const terminal = new TerminalUI(socket);
        terminal.attachTo(container);
        //terminal.startListening();
    },
    createTerminal(nodeId) {
        var frame = document.createElement("div");
        var container = document.createElement("div");
        var closeIcon = document.createElement("div");
        frame.classList.add("terminal-frame");
        container.classList.add("terminal-container");
        closeIcon.classList.add("term-close");
        frame.appendChild(closeIcon);
        frame.appendChild(container);
        document.getElementById("node-" + nodeId).after(frame);
        container.setAttribute("id", "term-" + nodeId);

        console.log("terminal created");
        $(frame).draggable({ cursor: "move"});
        $(frame).resizable();
        const ADDRESS = "127.0.0.1:443"
        console.log("connect on " + ADDRESS)
        /*this.connectToSocket(ADDRESS).then(socket => {
            this.startTerminal(container, socket);
        });*/
        this.startTerminal(container, null);
    }
}

export default termSetup