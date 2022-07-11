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
        var state = {nothing: "staten"};
        this.xhttp.open("GET", "state", false);
        this.xhttp.send();
        if (this.xhttp.status != 200) {
            alert("Can't get state of server terminals: bad response of the server")
        } else {
            state = this.xhttp.responseText; 
        }
        return state;
    }

    sendTopoToServer(topo) {
        fetch("/index/runtopo", { method: "POST", body: topo, headers: { 'Content-Type': 'text/plain' } })
        .then(function(response) {
            if (response.ok) {
                console.log("Topology successfully sent to server")
            } else {
                alert('Bad response of the server sending the topology');
            }
        })
        .catch(function(error) {
            alert('There was a problem sending the topology: ' + error.message);
        });
    }

    stopExecutionAtServer() {
        var success = true;
        fetch("/index/stoptopo")
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