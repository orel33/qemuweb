export class ServerExchanges {
    constructor() {
        this.xhttp = new XMLHttpRequest();
        this.xhttp.onabort = function(err) {
            console.log(err);
        }
    }

    /**
     * Get the OS distributions list from the server and store it in the DOM
     */
    getDistribFromServer() {
        this.xhttp.open("GET", "images", false);
        this.xhttp.send();
        if (this.xhttp.status != 200) {
            alert("Can't get distributions list: bad response of the server")
        } else {
            document.getElementById("distributions-storage").innerHTML = this.xhttp.responseText; 
        }
    }

    /**
     * Send an HTTP GET to the server to get the state of the client on the server
     * 
     * @returns the state of the client in JSON format
     */
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

    /**
     * Send an HTTP POST to the server with the topology topo as body
     * Purpose: Make the server run the topology topo
     * 
     * @param {String} topo the topology to send to the server 
     */
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

    /**
     * Send an HTTP POST to the server with the topology json as body.
     * Purpose: Get back the json of drawflow composition via client state if client is someway disconnected
     * 
     * @param {Object} json the json to send to the server
     */
    sendDrawflowToServer(json) {
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

    /**
     * Send an HTTP GET to the server to make the server stop the running topology
     * 
     * @returns true if the server responds OK
     */
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