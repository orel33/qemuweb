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

    topoToJSON() {
        console.log("TODO");
    }

    getRandomInt(max) {
        return Math.floor(Math.random() * max);
    }
  }