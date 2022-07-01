import { TerminalUI } from "@/js/TerminalUI";
import io from "socket.io-client";
import $ from 'jquery';
import jquery_ui from '@/jquery-ui/jquery-ui.js';

export class Terminal {
    constructor() {
        this.terminalUI = new TerminalUI();
        this.address = "127.0.0.1:443";
        this.connected = false;
    }

    connectToSocket(serverAddr) {
        return new Promise(res => {
            const socket = io(serverAddr);
            res(socket);
        });
    }

    startTerminal(socket) {
        this.terminalUI.startListening(socket);
    }

    startConnection() {
        console.log("connect on " + this.address)
        this.connectToSocket(this.address).then(socket => {
            this.startTerminal(socket);
            this.connected = true;
        });
    }

    createTerminal(nodeId, name) {
        var frame = document.createElement("div");
        var container = document.createElement("div");
        var closeIcon = document.createElement("div");
        var nameSpan = document.createElement("span");
        frame.classList.add("terminal-frame");
        container.classList.add("terminal-container");
        closeIcon.classList.add("term-close");
        nameSpan.classList.add("term-name");
        frame.appendChild(nameSpan);
        frame.appendChild(closeIcon);
        frame.appendChild(container);
        document.getElementById("node-" + nodeId).after(frame);
        frame.setAttribute("id", "term-" + nodeId);
        nameSpan.innerHTML = name;
        console.log("terminal" + " term-" + nodeId + " created");

        $(frame).draggable({ cursor: "move"});
        $(frame).resizable({ resize: function(ev) {
            var evt = new Event("resize");
            ev.target.dispatchEvent(evt);
        }});

        closeIcon.addEventListener("click", function () {
            frame.style.display = 'none';
        });

        this.terminalUI.attachTo(container);

        frame.style.display = 'none';
    }
}

export default Terminal