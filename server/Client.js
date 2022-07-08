const PTY = require("./PTYService");
const { exec } = require('child_process');
const Topology = require("./Topology");

class Client {
    constructor(userid) {
        this.userid = userid;
        this.ptysSwitch = {}; // Map<switchName, PTY>
        this.ptysHost = {}; // Map<hostName, PTY>
        this.ptyControl = new PTY();
        this.topology = new Topology();
        this.scriptsFolder = "/srv/qemuweb/server/scripts/";
    }

    requestTerm(name, type, socket) {
        var currPty = type == "host" ? this.ptysHost[name] : this.ptysSwitch[name];
        if (currPty.connected) {
            console.log("ALREADY CONNECTED")
        } else {
            currPty.bindTerminal(socket);
        }
    }

    initSession(topologyText) {
        this.ptyControl.sendCommand(this.scriptsFolder + "session-start.sh " + this.userid);
        this.ptyControl.sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-start.sh " + this.userid);
        this.topology.parse(topologyText);
        this.createSwitches();
        this.createHosts();
        console.log("Session initiated for user " + this.userid);
    }

    createSwitches() {
        for (var i in this.topology.switches) {
            const switchName = this.topology.switches[i];
            this.ptysSwitch[switchName] = new PTY("switch");
            this.ptysSwitch[switchName].sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-switch.sh " + this.userid + " " + switchName);
            console.log("Started switch " + switchName + " for user " + this.userid);
        }
    }

    createHosts() {
        for (var i in this.topology.hosts) {
            const host = this.topology.hosts[i];
            this.ptysHost[host.name] = new PTY("host");
            this.ptysHost[host.name].sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-host.sh " + this.userid 
                                        + " " + host.system + " " + host.name + " " + host.neighboors);
            console.log("Started host " + host.name + " for user " + this.userid);
        }
    }

    killQemunetSession() {
        this.ptyControl.sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-exit.sh " + this.userid);
        for (var key of Object.keys(this.ptysSwitch)) {
            this.ptysSwitch[key].killPtyProcess();
        }
        for (var key of Object.keys(this.ptysHost)) {
            this.ptysHost[key].killPtyProcess();
        }
        console.log("Qemunet session exited for " + this.userid);
    }

    killSession() {
        this.ptyControl.sendCommand(this.scriptsFolder + "session-killall.sh " + this.userid);
        console.log("Session killed for " + this.userid);
    }
}
  
module.exports = Client;