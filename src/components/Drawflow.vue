<template>
  <el-container>
    <el-header class="header">
        <h3>QemuWeb</h3>
        <div id="play-stop" class="play-button" @click="toggleEditorMode(); toggleMode()"></div>
        <div class="dropdown">
          <button @click="toggleDropDown" class="dropbtn">
            <span class="burger-slice"></span>
            <span class="burger-slice"></span>
            <span class="burger-slice"></span>
          </button>
          <div id="dropdownmenu" class="dropdown-content">
            <a href="#" @click="uploadJSON">
              Load
              <input type="file" id="import-json-input" accept="application/json" @change="importJSON" style="width:0px;width:0px">
            </a>
            <a href="#" @click="exportEditor(); exportJSON(dialogData)">Save</a>
            <a href="#" @click="uploadTopo()">
              Import
              <input type="file" id="import-topo-input" @change="importTopo" style="width:0px;width:0px">
            </a>
            <a href="#" @click="exportEditorTopo(); exportTopo(topoData)">Export</a>
            <a id="open-settings" href="#" @click="displaySettings">Settings</a>
            <a href="#" @click="displayAbout">About</a>
          </div>
        </div>
    </el-header>
    <el-container class="container">
      <el-aside width="110px" class="column">
          <ul>
              <li v-for="n in listNodes" :key="n" draggable="true" :data-node="n.item" @dragstart="drag($event)" class="drag-drawflow" >
                  <div class="node" :style="`background: ${n.color};text-align: center`" >
                    <img :class="n.img_class" :src="n.img"/>
                  </div>
              </li>
          </ul>
      </el-aside>
      <el-main>
          <div id="drawflow" @drop="drop($event)" @dragover="allowDrop($event)"></div>
      </el-main>
    </el-container>
  </el-container>
  <el-dialog v-model="dialogSettings" title="Settings" width="50%">
    <div class="modal-section">
      <span> Display interfaces name : </span>
      <input id="interfaces-name-check" type="checkbox" checked @change="settings.changeDisplayInterfacesName">
    </div>
    <div class="modal-section">
      <span> Display ports name : </span>
      <input id="ports-name-check" type="checkbox" checked @change="settings.changeDisplayPortsName">
    </div>
    <div class="modal-section">
      <span> Curved connections : </span>
      <input id="curved-check" type="checkbox" checked @change="settings.changeCurvedConnections">
    </div>
    <div class="modal-section">
      <span> Reduced mode : </span>
      <input id="reduced-check" type="checkbox" @change="settings.changeReducedMode">
      <img class="info-img" src="@/assets/info.png" title="Hide outputs/inputs circle">
    </div>
  </el-dialog>
  <el-dialog v-model="dialogAbout" title="About" width="50%">
   <div class="modal-section">
      <div class="about-line">
        <img src="@/assets/gitlab.png">
        <a class="about-link" href="https://gitlab.emi.u-bordeaux.fr/qemunet/qemuweb">Source Code</a>
      </div>
      <div id="ub-link">
        <img src="@/assets/UB.png">
        <a class="about-link" href="https://www.u-bordeaux.fr/">University of Bordeaux</a>
      </div>
    </div>
  </el-dialog>
  <div id="settings" style="width:0;height:0"></div>
</template>


<script>
import drawflow from 'drawflow';
import styleDrawflow from 'drawflow/dist/drawflow.min.css';
import style from '../assets/style.css';
import styleJquery from '../jquery-ui/jquery-ui.min.css';
import $ from 'jquery';
import jquery_ui from '../jquery-ui/jquery-ui.js';
import { onMounted, shallowRef, h, getCurrentInstance, render, readonly, ref } from 'vue';
import { Settings } from '@/Settings';
import { SystemIO } from '@/SystemIO';
import Host from './nodes/HostComp.vue';
import Switch from './nodes/SwitchComp.vue';


export default {
  name: 'DrawFlow',
  data() {
    return {
      serverAddress: "127.0.0.1:443",
      dialogSettings: false,
      dialogAbout: false,
      terminalSetup: null,
      settings: null,
      systemIO: null
    }
  },
  methods: {
    toggleDropDown() {
      document.getElementById("dropdownmenu").classList.toggle("show");
    },
    toggleMode() {
      var aside = document.querySelector("aside");
      var cogs = document.querySelectorAll(".cog");
      var runPrompts = document.querySelectorAll(".run-prompt");
      var prompts = document.querySelectorAll(".terminal-frame");

      document.getElementById("play-stop").classList.toggle("play-button");
      document.getElementById("play-stop").classList.toggle("stop-button");
      aside.style.display = aside.style.display == 'none' ? 'initial' : "none";
      for (let i = 0; i < document.querySelectorAll(".cog").length; i++) {
        cogs[i].style.display = cogs[i].style.display == 'none' ? 'initial' : 'none';
        runPrompts[i].style.display = runPrompts[i].style.display == 'initial' ? 'none' : 'initial';
        prompts[i].style.display = 'none';
      }
    },
    displaySettings() {
      this.dialogSettings = true;
    },
    displayAbout() {
      this.dialogAbout = true;
    },
    exportJSON(data) {
      this.systemIO.saveFile(JSON.stringify(data), "export.json", "json");
    },
    uploadJSON() {
      var input = document.getElementById("import-json-input");
      input.click();
    },
    importJSON() {
      var input = document.getElementById("import-json-input");
      var importEditor = this.importEditor;

      if (input.files.length == 0) {
        return;
      }

      this.systemIO.readFile(input.files[0], function(content) {
        importEditor(JSON.parse(content));
        input.value = null;
      })
    },
    exportTopo(data) {
      console.log("Exporting data = \n", data);
      this.systemIO.saveFile(data, "export.topo", "topo");
    },
    uploadTopo() {
      var input = document.getElementById("import-topo-input");
      input.click();
    },
    getRandomInt(max) {
      return Math.floor(Math.random() * max);
    },
    importTopo() {
      var input = document.getElementById("import-topo-input");
      var importEditor = this.importEditor;

      if (input.files.length == 0) {
        return;
      }
      const comp = this;
      const io = this.systemIO;
      this.systemIO.readFile(input.files[0], function(content) {
        var fullData = io.topoToJSON(content);
        importEditor(fullData);
        input.value = null;
      });
    }
  },
  mounted() {
    // Close the dropdown menu if the user clicks outside of it
    window.addEventListener('click', function(event) {
      if (!event.target.matches('.dropbtn') && !event.target.matches('.burger-slice')) {
        var dropdowns = document.getElementsByClassName("dropdown-content");
        var i;
        for (i = 0; i < dropdowns.length; i++) {
          var openDropdown = dropdowns[i];
          if (openDropdown.classList.contains('show')) {
            openDropdown.classList.remove('show');
          }
        }
      }
    });

    this.systemIO = new SystemIO();
    this.settings = new Settings();
    this.settings.mountInDOM();
    this.settings.setOption('display-ports-name', true);
    this.settings.setOption('display-interfaces-name', true);
    this.settings.setOption('curved-connections', true);
    this.settings.setOption('reduced-mode', true);
  },
  setup() {
    const listNodes = readonly([
      {
        name: 'HOST',
        color: '#49494970',
        item: 'Host',
        input: 0,
        output: 1,
        img: require('@/assets/computer.png'),
        img_class: 'computer'
      },
      {
        name: 'SWITCH',
        color: 'blue',
        item: 'Switch',
        input: 4,
        output: 0,
        img: require('@/assets/switch.png'),
        img_class: 'switch'
      }
    ])
    
    var editor;// = shallowRef({})
    const dialogData = ref({});
    const topoData = ref({});
    const Vue = { version: 3, h, render };
    const internalInstance = getCurrentInstance();
    
    function exportEditor() {
      dialogData.value = editor.export();
    }

    function importEditor(data) {
      if (Object.keys(editor.export().drawflow.Home.data).length > 0) {
        var confirm =  window.confirm("En important vous allez effacer la composition actuelle. Êtes-vous sûr ?");
        if (confirm) {
          editor.clear();
          editor.nodeId = 1; // reset nodeId because clear() doesn't do it
          dialogData.value = editor.import(data);
        }
      } else {
        dialogData.value = editor.import(data);
      }
    }

    function exportEditorTopo() {
      var jsonData = editor.export().drawflow.Home.data;
      var result = "";
      var key, node;
      for (key of Object.keys(jsonData)) {
        node = jsonData[key];
        if (node.class == "Switch") {
          result += "SWITCH " + node.data.name + "\n";
        }
      }
      for (key of Object.keys(jsonData)) {
        node = jsonData[key];
        if (node.class == "Host") {
          result += "HOST " + node.data.system + " " + node.data.name;
          for (var i of Object.keys(jsonData[key].outputs)) {
            if (jsonData[key].outputs[i].connections.length > 0) {
              var eth = jsonData[key].outputs[i].connections[0];
              result +=  " " + editor.getNodeFromId(Number(eth.node)).data.name + ":" + (Number(eth.output.split('_')[1])-1);
            }
          }
          result += "\n";
        }
      }
      topoData.value = result;
    }

    const drag = (ev) => {
      if (ev.type === "touchstart") {
        mobile_item_selec = ev.target.closest(".drag-drawflow").getAttribute('data-node');
      } else {
        ev.dataTransfer.setData("node", ev.target.getAttribute('data-node'));
      }
    }
    const drop = (ev) => {
      if (ev.type === "touchend") {
        var parentdrawflow = document.elementFromPoint( mobile_last_move.touches[0].clientX, mobile_last_move.touches[0].clientY).closest("#drawflow");
        if(parentdrawflow != null) {
          addNodeToDrawFlow(mobile_item_selec, mobile_last_move.touches[0].clientX, mobile_last_move.touches[0].clientY);
        }
        mobile_item_selec = '';
      } else {
        ev.preventDefault();
        var data = ev.dataTransfer.getData("node");
        addNodeToDrawFlow(data, ev.clientX, ev.clientY);
      }
    }
    const allowDrop = (ev) => {
      ev.preventDefault();
    }

    let mobile_item_selec = '';
    let mobile_last_move = null;
    function positionMobile(ev) {
      mobile_last_move = ev;
    }

    function addNodeToDrawFlow(name, pos_x, pos_y) {
      pos_x = pos_x * ( editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom)) - (editor.precanvas.getBoundingClientRect().x * ( editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom)));
      pos_y = pos_y * ( editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom)) - (editor.precanvas.getBoundingClientRect().y * ( editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom)));
    
      const nodeSelected = listNodes.find(ele => ele.item == name);
      editor.addNode(name, nodeSelected.input, nodeSelected.output, pos_x, pos_y, name, {}, name, 'vue');
    }

    function toggleEditorMode() {
      editor.editor_mode = editor.editor_mode == 'edit' ? 'fixed' : 'edit';
    }

    onMounted(() => {

      var elements = document.getElementsByClassName('drag-drawflow');
      for (var i = 0; i < elements.length; i++) {
        elements[i].addEventListener('touchend', drop, false);
        elements[i].addEventListener('touchmove', positionMobile, false);
        elements[i].addEventListener('touchstart', drag, false );
      }
        
        const id = document.getElementById("drawflow");

        editor = new drawflow(id, Vue, internalInstance.appContext.app._context);
        editor.force_first_input = true;

        editor.start();
        
        editor.registerNode('Host', Host, {}, {});
        editor.registerNode('Switch', Switch, {}, {});

        console.log(editor);

        //editor.import({"drawflow":{"Home":{"data":{"5":{"id":5,"name":"Switch","data":{"script":"(req,res) => {\n console.log(req);\n}"},"class":"Switch","html":"Switch","typenode":"vue","inputs":{"input_1":{"connections":[{"node":"6","input_1":"output_1"}]}},"outputs":{"output_1":{"connections":[]},"output_1":{"connections":[]}},"pos_x":1000,"pos_y":117},"6":{"id":6,"name":"Host","data":{"url":"localhost/add", "method": "post"},"class":"Host","html":"Host","typenode":"vue","inputs":{},"outputs":{"output_1":{"connections":[{"node":"5","output":"input_1"}]}},"pos_x":137,"pos_y":89}}}}})
        internalInstance.appContext.app._context.config.globalProperties.$df = editor;
    })

    return {
      exportEditor, listNodes, drag, drop, allowDrop, dialogData, importEditor, exportEditorTopo, topoData, toggleEditorMode
    }

  }
}

</script>

<style scoped>
.header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #494949;
}
.container {
    min-height: calc(100vh - 100px);
}
.column {
    border-right: 1px solid #494949;
}
.column ul {
    padding-inline-start: 0px;
    padding: 10px 8px;
}
.column li {
    background: transparent;
}

.node {
    border-radius: 8px;
    border: 2px solid #494949;
    display: block;
    height:88px;
    line-height:40px;
    padding: 10px;
    margin: 10px 0px;
    cursor: move;
}

#drawflow {
  width: 100%;
  height: 97%;
  text-align: initial;
  background: #2b2c30;
  background-size: 20px 20px;
  background-image: radial-gradient(#494949 1px, transparent 1px); 
}
</style>