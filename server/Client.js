const PTY = require("./PTYService");
const { exec } = require('child_process');
const Topology = require("./Topology");

class Client {
    constructor(userid) {
        this.userid = userid;
        this.ptys = {}; // Map<socketID, PTYService>
        this.topology = new Topology();
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

    initSession(topologyText) {
        exec("./scripts/session-start.sh " + this.userid, (err, stdout, stderr) => {
            console.log("Session started for " + this.userid);
        });
        exec("./scripts/session-run-cmd.sh ./scripts/qemunet-start.sh " + this.userid, (err, stdout, stderr) => {
            console.log("Qemunet started for " + this.userid);
        });
        this.topology.parse(topologyText);
    }

    createSwitches() {
        exec("./scripts/session-run-cmd.sh ./scripts/qemunet-start.sh " + this.userid, (err, stdout, stderr) => {
            console.log("Qemunet started for " + this.userid);
        });
    }
}
  
module.exports = Client;