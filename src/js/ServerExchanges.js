export class ServerExchanges {
    getDistribFromServer() {
        fetch('images')
        .then(function(response) {
            if(response.ok) {
                response.json().then(function(json) {
                    document.getElementById("distributions-storage").innerHTML = JSON.stringify(json);
                });
            } else {
                console.log('fetch: Bad response response of network');
            }
        })
        .catch(function(error) {
            console.log('There was a problem retrieving the list of available systems: ' + error.message);
        });
    }

    getTerminalsState() {
        var state = {};
        fetch("/index/state")
        .then(function(response) {
            if (response.ok) {
                response.json().then(function(json) {
                    state = json;
                });
            } else {
                console.log('Bad response of the server getting the terminals state');
            }
        })
        .catch(function(error) {
            console.log('There was a problem getting the terminals state: ' + error.message);
        });
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