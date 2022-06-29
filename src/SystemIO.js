export class SystemIO {
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

    readFile(file, callback) {
        var reader = new FileReader();
        var content = "nothing";
        reader.onload = function(event) {
            content = event.target.result;
            callback(content);
        };
        reader.readAsText(file);
    }

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
                console.log("Switch !")
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
                console.log("Host !")
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
                for (let i = 3; i < words.length; i++) {
                    var switchName = words[i].split(':')[0];
                    var portNumber = Number(words[i].split(':')[1]) + 1;
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

                    // CONNECTIONS
                    data[currId]["outputs"]["output_" + (i-2)] = {"connections": [{"node": coSwitch.id, "output": "input_" + data[coSwitch.id].data.portsCount}]};
                    data[coSwitch.id]["inputs"]["input_" + data[coSwitch.id].data.portsCount] = {"connections": [{"node": currId, "input": "output_" + (i-2)}]};
                    data[coSwitch.id].data.portsCount++;
                }
                currId++;
            }
        }
        this.saveFile(JSON.stringify(fullData), "test.json", "json");
        return fullData;
    }

    getRandomInt(max) {
        return Math.floor(Math.random() * max);
    }
  }