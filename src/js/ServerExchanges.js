export class ServerExchanges {
    constructor() {
        this.xhttp = new XMLHttpRequest();
        this.xhttp.onabort = function(err) {
            console.log(err);
        }
    }

    getDistribFromServer() {
        this.xhttp.open("GET", "images", false);
        this.xhttp.send();
        if (this.xhttp.status != 200) {
            alert("Can't get distributions list: bad response of the server")
        } else {
            document.getElementById("distributions-storage").innerHTML = this.xhttp.responseText; 
        }
    }

    getServerState() {
        var state = {nothing: "nothing"};
        this.xhttp.open("GET", "state", false);
        this.xhttp.send();
        if (this.xhttp.status != 200) {
            alert("Can't get state of server terminals: bad response of the server")
        } else {
            state = JSON.parse(this.xhttp.responseText);
        }
        return state;
    }

    sendTopoToServer(topo) {
        fetch("runtopo", { method: "POST", body: topo, headers: { 'Content-Type': 'text/plain' } })
        .then(function(response) {
            if (response.ok) {
                console.log("SERVER: Topology successfully received, running it...")
            } else {
                alert('Bad response of the server sending the topology');
            }
        })
        .catch(function(error) {
            alert('There was a problem sending the topology: ' + error.message);
        });
    }

    sendDrawflowToServer(json) {
        console.log("JSON TO SEND TO SERVER: ", JSON.stringify(json));
        fetch("registerjson", { method: "POST", body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } })
        .then(function(response) {
            if (!response.ok) {
                console.log('Bad response of the server sending drawflow json');
            }
        })
        .catch(function(error) {
            console.log('There was a problem sending drawflow json: ' + error.message);
        });
    }

    stopExecutionAtServer() {
        var success = true;
        fetch("stoptopo")
        .then(function(response) {
            if (response.ok) {
                console.log("SERVER: Execution successfully stopped")
            } else {
                alert('Bad response of the server sending the execution stop');
                success = false;
            }
        })
        .catch(function(error) {
            alert('There was a problem sending the execution stop: ' + error.message);
            success = false;
        });
        return success;
    }
}