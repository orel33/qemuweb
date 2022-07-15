export class SystemIO {
    /**
     * Save a file locally
     * @param {*} data the data to write in the file
     * @param {String} filename the name of the file
     * @param {String} type the type of the file
     */
    saveFile(data, filename, type) {
        var file = new Blob([data], {type: type});
        var a = document.createElement("a"), url = URL.createObjectURL(file);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);  
        }, 0); 
    }

    /**
     * Read a local file
     * @param {Blob, File} file the file to read
     * @param {Function} callback the function called when the file is read 
     */
    readFile(file, callback) {
        var reader = new FileReader();
        var content = "nothing";
        reader.onload = function(event) {
            content = event.target.result;
            callback(content);
        };
        reader.readAsText(file);
    }

    /**
     * Convert a topology to a JSON understandable by Drawflow 
     * @param {String} content the topology
     * @returns a JSON understandable by Drawflow
     */
    topoToJSON(content) {
        var lines = content.split('\n');
        var fullData = { "drawflow": { "Home": { "data": {}}}};
        var data = fullData.drawflow.Home.data;
        var currId = 1;
        for (const line of lines) {
            var firstChar = line[line.search(/\S/)];
            if (firstChar == '#') {
                continue;
            }
            var words = line.split(' ');

            // SWITCHES
            if (words[0] == "SWITCH") {
                data[currId] = {"id": currId, 
                                "name": "Switch", 
                                "data": {"name": words[1], "portsCount": 1},
                                "class": "Switch",
                                "html": "Switch",
                                "typenode": "vue",
                                "inputs": {"input_1": {"connections": []}},
                                "outputs": {},
                                "pos_x": this.getRandomInt(900),
                                "pos_y": this.getRandomInt(600)}
                currId++;
            }

            // HOSTS
            if (words[0] == "HOST") {
                data[currId] = {"id": currId, 
                                "name": "Host", 
                                "data": {"name": words[2], "interfacesCount": words.length - 3, "system": words[1]},
                                "class": "Host",
                                "html": "Host",
                                "typenode": "vue",
                                "inputs": {},
                                "outputs": {},
                                "pos_x": this.getRandomInt(900),
                                "pos_y": this.getRandomInt(600)}

                // CONNECTIONS
                var portNumber;
                
                for (let i = 3; i < words.length; i++) {
                    var switchName = words[i].split(':')[0];
                    portNumber = Number(words[i].split(':')[1]) + 1;
                    portNumber = Number.isNaN(portNumber) ? data[coSwitch.id].data.portsCount : portNumber;
                    var coSwitch = null;
                    for (let key of Object.keys(data)) {
                        var node = data[key];
                        if (node.class == "Switch") {
                            if (switchName == node.data.name) {
                            coSwitch = node;
                            break;
                            }
                        }
                    }
                    for (let j = 1; j < portNumber; j++) {
                        if ( !(("input_" + j) in data[coSwitch.id]["inputs"]) ) {
                            data[coSwitch.id]["inputs"]["input_" + j] = {"connections": []};
                        }
                    }

                    data[currId]["outputs"]["output_" + (i-2)] = {"connections": [{"node": coSwitch.id, "output": "input_" + portNumber}]};
                    data[coSwitch.id]["inputs"]["input_" + portNumber] = {"connections": [{"node": currId, "input": "output_" + (i-2)}]};
                    data[coSwitch.id].data.portsCount++;
                }
                currId++;
            }
        }
        return fullData;
    }

    /**
     * Return a random integer
     * @param {Number} max the ceil for the random integer 
     * @returns a random integer between 0 and max
     */
    getRandomInt(max) {
        return Math.floor(Math.random() * max);
    }
  }