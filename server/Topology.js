class Topology {
    constructor() {
        this.switches = [];
        this.hosts = [];
    }

    parse(textContent) {
        var lines = textContent.split('\n');
        for (const line of lines) {
            var firstChar = line[line.search(/\S/)];
            if (firstChar == '#') {
                continue;
            }
            var words = line.split(' ');

            // SWITCHES
            if (words[0] == "SWITCH") {
                this.switches.push(words[1]);
            }

            // HOSTS
            if (words[0] == "HOST") {
                var host = {};
                host["system"] = words[1];
                host["name"] = words[2];
                var neighboors = "";
                // CONNECTIONS
                for (let i = 3; i < words.length; i++) {
                    neighboors += words[i] + " "
                }
                host["neighboors"] = neighboors;
                this.hosts.push(host);
            }
        }
    }
}
  
module.exports = Topology;