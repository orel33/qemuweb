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
        this.scriptsPath = "/srv/qemuweb/server/scripts/";
        //this.activeSessions = 0;
        //this.attachedSessions = 0;
    }

    /*initSession(socket) {
        this.ptys[socket.id] = new PTY(socket);
        console.log("first session for client, create on " + this.userid + "_" + 0);
        this.ptys[socket.id].createSession(this.userid, 0);
        this.activeSessions++;
        this.attachedSessions++;
        var timeBeforeKillSessions = 1; // Minutes
        //this.killSessions(this.userid, 1);
        //console.log("Sessions with userid " + this.userid + " will be killed in" + timeBeforeKillSessions + " minutes");
    }

    requestNewSession(socket) {
        this.ptys[socket.id] = new PTY(socket);

        if (this.activeSessions > this.attachedSessions) {
            // Give existing session
            console.log("requestNewSession : attach on " + this.userid + "_" + this.attachedSessions);
            this.ptys[socket.id].attachSession(this.userid, this.attachedSessions);
            this.attachedSessions++;
        } else if (this.activeSessions == this.attachedSessions) {
            // Create new session
            console.log("requestNewSession : create on " + this.userid + "_" + this.activeSessions);
            this.ptys[socket.id].createSession(this.userid, this.activeSessions);
            this.activeSessions++;
            this.attachedSessions++;
        }
    }

    killSessions(userid, time) {
        exec("./killSessions.sh " + userid + " " + time, (err, stdout, stderr) => {
            console.log("All sessions with userid " + userid + " were killed");
            this.activeSessions = 0;
            this.attachedSessions = 0;
        });
    }*/

    requestTerm(name, type, socket) {
        var currPty = type == "host" ? this.ptysHost[name] : this.ptysSwitch[name];
        if (currPty.connected) {
            console.log("ALREADY CONNECTED")
        } else {
            currPty.bindTerminal(socket);
        }
    }

    initSession(topologyText) {
        this.ptyControl.sendCommand(this.scriptsPath + "session-start.sh " + this.userid);
        this.ptyControl.sendCommand(this.scriptsPath + "session-run-cmd.sh " + this.scriptsPath + "qemunet-start.sh " + this.userid);
        this.topology.parse(topologyText);
        this.createSwitches();
        this.createHosts();
        console.log("Session initiated for user " + this.userid);
    }

    createSwitches() {
        for (const switchName in this.topology.switches) {
            this.ptysSwitch[switchName] = new PTY("switch");
            this.ptysSwitch[switchName].sendCommand(this.scriptsPath + "session-run-cmd.sh " + this.scriptsPath + "qemunet-switch.sh " + this.userid + " " + switchName);
            console.log("Started switch " + switchName + " for user " + this.userid);
        }
    }

    createHosts() {
        for (var i in this.topology.hosts) {
            const host = this.topology.hosts[i];
            this.ptysHost[host.name] = new PTY("host");
            this.ptysHost[host.name].sendCommand(this.scriptsPath + "session-run-cmd.sh " + this.scriptsPath + "qemunet-host.sh " + this.userid 
                                        + " " + host.system + " " + host.name + " " + host.neighboors);
            console.log("Started host " + host.name + " for user " + this.userid);
        }
    }

    killQemunetSession() {
        this.ptyControl.sendCommand(this.scriptsPath + "session-run-cmd.sh " + this.scriptsPath + "qemunet-exit.sh " + this.userid);
        console.log("Qemunet session exited for " + this.userid);
    }

    killSession() {
        this.ptyControl.sendCommand(this.scriptsPath + "session-killall.sh " + this.userid);
        console.log("Session killed for " + this.userid);
    }
}
  
module.exports = Client;