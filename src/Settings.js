export class Settings {
    constructor() {
        this.container = document.getElementById("settings");
    }

    setOption(name, value) {
        this.container.setAttribute("data-" + name, value);
    }

    getOption(name) {
        return this.container.getAttribute("data-" + name);
    }
  }