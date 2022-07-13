const PTY = require("./PTYService");
const { exec } = require('child_process');
const Topology = require("./Topology");

class Client {
    constructor(userid) {
        this.userid = userid;
        this.ptysSwitch = {}; // Map<switchName, PTY>
        this.ptysHost = {}; // Map<hostName, PTY>
        this.ptyControl = new PTY(true, "");
        this.topology = new Topology();
        this.scriptsFolder = "/srv/qemuweb/server/scripts/";
        this.runningMachines = false;
        this.timeToDie = null;
    }

    requestTerm(name, type, socket) {
        var currPty = type == "host" ? this.ptysHost[name] : this.ptysSwitch[name];
        currPty.bindTerminal(socket);
    }

    initSession(topologyText) {
        if (this.ptyControl.killed) {
            this.ptyControl = new PTY(true, "");
        }
        this.ptyControl.sendCommand(this.scriptsFolder + "session-start.sh " + this.userid);
        this.ptyControl.sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-start.sh " + this.userid);
        this.topology.parse(topologyText);
        this.createSwitches();
        this.createHosts();
        this.runningMachines = true;
        console.log("Session initiated for user " + this.userid);
    }

    createSwitches() {
        for (var i in this.topology.switches) {
            const switchName = this.topology.switches[i];
            this.ptysSwitch[switchName] = new PTY(false, this.userid);
            this.ptysSwitch[switchName].sendCommand(this.scriptsFolder + "session-run-cmd.sh " + this.scriptsFolder + "qemunet-switch.sh " + this.userid + " " + switchName);
            console.log("Started switch " + switchName + " for user " + this.userid);
        }
    }

    createHosts() {
        for (var i in this.topology.hosts) {
            const host = this.topology.hosts[i];
            this.ptysHost[host.name] = new PTY(false, this.userid);
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
        this.ptysSwitch = {};
        this.ptysHost = {};
        this.runningMachines = false;
        console.log("Qemunet session exited for " + this.userid);
    }

    killSession() {
        this.ptyControl.sendCommand(this.scriptsFolder + "session-killall.sh " + this.userid);
        for (var key of Object.keys(this.ptysSwitch)) {
            this.ptysSwitch[key].killPtyProcess();
        }
        for (var key of Object.keys(this.ptysHost)) {
            this.ptysHost[key].killPtyProcess();
        }
        this.ptysSwitch = {};
        this.ptysHost = {};
        this.runningMachines = false;
        console.log("Session killed for " + this.userid);
    }

    registerDrawflowJSON(json) {
        this.topology.drawflowJSON = json;
    }

    getState() {
        var state = { running: this.runningMachines, topology: this.topology.text, drawflow: this.topology.drawflowJSON };
        var ptys = {};
        ptys["control"] = { killed: this.ptyControl.killed }

        var hosts = {};
        for (var key of Object.keys(this.ptysHost)) {
            var h = this.ptysHost[key];
            hosts[key] = { connected: h.connected, killed: h.killed }
        }
        ptys["hosts"] = hosts;

        var switches = {};
        for (var key of Object.keys(this.ptysSwitch)) {
            var s = this.ptysSwitch[key];
            switches[key] = { connected: s.connected, killed: s.killed }
        }
        ptys["switches"] = switches;

        state["ptys"] = ptys;

        return state;
    }
}
  
module.exports = Client;