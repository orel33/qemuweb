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

        const ADDRESS = "127.0.0.1:443"
        console.log("connect on " + ADDRESS)
        /*this.connectToSocket(ADDRESS).then(socket => {
            this.startTerminal(container, socket);
        });*/
        this.startTerminal(container, null);
        frame.style.display = 'none';
    }
}

export default termSetup