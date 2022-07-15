import { TerminalUI } from "@/js/TerminalUI";
import io from "socket.io-client";
import $ from 'jquery';
import jquery_ui from '@/jquery-ui/jquery-ui.js';

export class Terminal {
    constructor(id, type) {
        this.terminalUI = new TerminalUI();
        this.address = (location.protocol == "https:" ? "wss://" : "ws://") + location.host;
        this.connected = false;
        this.type = type;
        this.id = id;
    }

    connectToSocket(serverAddr) {
        return new Promise(res => {
            var name = document.getElementById("term-" + this.id).querySelector(".term-name").innerHTML;
            const socket = io(serverAddr, { query: {name: name, type: this.type} });
            res(socket);
        });
    }

    startListening(socket) {
        this.terminalUI.startListening(socket);
    }

    startConnection() {
        console.log("connect on " + this.address)
        this.connectToSocket(this.address).then(socket => {
            this.startListening(socket);
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

        $(frame).draggable({ cursor: "move"});
        $(frame).resizable({ resize: function(ev) {
            var evt = new Event("resize");
            ev.target.dispatchEvent(evt);
        }});

        closeIcon.addEventListener("click", function () {
            frame.style.display = 'none';
        });

        // fix conflict between xtermjs and draggable
        container.addEventListener("mousedown", function(ev) {
            ev.stopPropagation();
        });

        this.terminalUI.attachTo(container);

        frame.style.display = 'none';
    }
}

export default Terminal