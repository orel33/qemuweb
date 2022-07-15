<template>
  <el-container>
    <el-header class="header">
        <div id="header-left">
          <h3 id="header-title">QemuWeb</h3>
          <div id="play-stop" class="play-button" @click="toggleExecution()"></div>
        </div>
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
            <a href="#" @click="exportJSON()">Save</a>
            <a href="#" @click="uploadTopo()">
              Import
              <input type="file" id="import-topo-input" @change="importTopo" style="width:0px;width:0px">
            </a>
            <a href="#" @click="exportTopo()">Export</a>
            <a id="open-settings" href="#" @click="displaySettings">Settings</a>
            <a href="#" @click="displayAbout">About</a>
          </div>
        </div>
    </el-header>
    <el-container class="container">
      <el-aside width="60px" class="column">
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
      <input id="reduced-check" type="checkbox" @change="settings.updateReducedMode">
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
  <div id="distributions-storage" style="width:0;height:0"></div>
</template>


<script>
import drawflow from 'drawflow';
import styleDrawflow from 'drawflow/dist/drawflow.min.css';
import style from '@/style.css';
import styleJquery from '@/jquery-ui/jquery-ui.min.css';
import $ from 'jquery';
import jquery_ui from '@/jquery-ui/jquery-ui.js';
import { onMounted, shallowRef, h, getCurrentInstance, render, readonly, ref } from 'vue';
import { Settings } from '@/js/Settings';
import { SystemIO } from '@/js/SystemIO';
import { ServerExchanges } from '@/js/ServerExchanges';
import Host from './nodes/HostComp.vue';
import Switch from './nodes/SwitchComp.vue';


export default {
  name: 'DrawFlow',
  data() {
    return {
      dialogSettings: false,
      dialogAbout: false,
      settings: null,
      systemIO: null,
      serverExchanges: null,
      execMode: false
    }
  },
  methods: {
    /* Edit/Execution mode */
    toggleExecution(serverRunning = false) {
      /**
       * Enable/Disable execution mode
       */

      // Tell to the server to run/stop
      if (!this.execMode) {
        if (document.getElementsByClassName('drawflow-node').length == 0 && !serverRunning) {
          alert("The virtual network has no components!");
          return;
        }
        if (!this.checkNamesUnicity() && !serverRunning) {
          alert("Some components have the same name : can't run the virtual network");
          return;
        }
        this.toExecMode();  
      } else {
        var conf = window.confirm("You will stop the virtual network execution and kill savagely all the machines, do you confirm?")
        if (!conf) { return; }
        if (!this.serverExchanges.stopExecutionAtServer()) { return; }
      }


      // Then update the view on the page

      this.toggleEditorMode();

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
        if (prompts[i]) {
          prompts[i].style.display = 'none';
        }
      }

      this.execMode = !this.execMode;
    },
    toExecMode() {
      /**
       * Switch to execution mode by sending topology to the server
       * if already in execution mode (on refresh) only load the topology
       */
      var state = this.serverExchanges.getServerState();
      if (state.running && state.topology.length > 0) {
        if (state.drawflow && state.drawflow.drawflow) {
          this.importEditor(state.drawflow);  
        } else {
          this.importEditor(this.systemIO.topoToJSON(state.topology));
        }
      } else {
        this.exportEditorTopo();
        this.serverExchanges.sendTopoToServer(this.topoData);
        this.exportEditor();
        this.serverExchanges.sendDrawflowToServer(this.JSONData);
      }
    },
    checkNamesUnicity() {
      /**
       *  Return true if there is no duplicate names for hosts or switches, false if there is duplication 
       */
      var hostsName = Array.from(document.getElementsByClassName('host-name'), span => span.innerHTML);
      var switchesName = Array.from(document.getElementsByClassName('switch-name'), span => span.innerHTML);
      if (hostsName.length > new Set(hostsName).size || switchesName.length > new Set(switchesName).size) {
        return false;
      }
      return true;
    },

    /* Handle general modals display */
    displaySettings() {
      this.dialogSettings = true;
    },
    displayAbout() {
      this.dialogAbout = true;
    },
    toggleDropDown() {
      document.getElementById("dropdownmenu").classList.toggle("show");
    },

    /* Import/Export */
    exportJSON() {
      /**
       * save JSON of drawflow composition locally
       */
      this.exportEditor();
      this.systemIO.saveFile(JSON.stringify(this.JSONData), "export.json", "json");
    },
    uploadJSON() {
      /**
       * Trigger the hidden file input for JSON load
       */
      var input = document.getElementById("import-json-input");
      input.click();
    },
    importJSON() {
      /**
       * load JSON of drawflow compostion from local file
       */
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
    exportTopo() {
      /**
       * save locally the topology file from current composition
       */
      this.exportEditorTopo();
      this.systemIO.saveFile(this.topoData, "export.topo", "topo");
    },
    uploadTopo() {
      /**
       * Trigger the hidden file input for topology file load
       */
      var input = document.getElementById("import-topo-input");
      input.click();
    },
    importTopo() {
      /**
       * load topology from local topology file in current composition
       */
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
    this.systemIO = new SystemIO();
    this.settings = new Settings();
    this.serverExchanges = new ServerExchanges();
    this.settings.mountInDOM();
    this.settings.setOption('display-ports-name', true);
    this.settings.setOption('display-interfaces-name', true);
    this.settings.setOption('curved-connections', true);
    this.settings.setOption('reduced-mode', false);

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

    // If the server is in running state, load its composition
    this.serverExchanges.getDistribFromServer();
    if (this.serverExchanges.getServerState().running) {
      this.toggleExecution(true);
    }
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
    
    var editor;
    const JSONData = ref({});
    const topoData = ref({});
    const Vue = { version: 3, h, render };
    const internalInstance = getCurrentInstance();
    
    function exportEditor() {
      JSONData.value = editor.export();
    }

    /**
     * Load a JSON of drawflow composition in editor
     * @param {String} data the data containing the JSON
     */
    function importEditor(data) {
      if (Object.keys(editor.export().drawflow.Home.data).length > 0) {
        var confirm =  window.confirm("En important vous allez effacer la composition actuelle. Êtes-vous sûr ?");
        if (confirm) {
          editor.clear();
          editor.nodeId = 1; // reset nodeId because clear() doesn't do it
          JSONData.value = editor.import(data);
        }
      } else {
        JSONData.value = editor.import(data);
      }

      // Force to use setTimeout to delay the re-draw because drawflow seems to draw (badly) the connections after this function is executed
      setTimeout(() => {
        var allNodes = editor.getNodesFromName('Host').concat(editor.getNodesFromName('Switch'));
        for (let id of allNodes) {
          // Re-draw all connections
          editor.updateConnectionNodes("node-" + id);
        }
      }, 500);
    }

    /**
     * Convert the JSON of current composition to a topology file data
     * The result is store in topoData
     */
    function exportEditorTopo() {
      var data = editor.export().drawflow.Home.data;
      var result = "";
      var key, node;
      for (key of Object.keys(data)) {
        node = data[key];
        if (node.class == "Switch") {
          result += "SWITCH " + node.data.name + "\n";
        }
      }
      for (key of Object.keys(data)) {
        node = data[key];
        if (node.class == "Host") {
          result += "HOST " + node.data.system + " " + node.data.name;
          for (var i of Object.keys(node.outputs)) {
            if (node.outputs[i].connections.length > 0) {
              var eth = node.outputs[i].connections[0];
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
        addNodeToDrawFlow(data, ev.clientX - 50, ev.clientY - 50);
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

        internalInstance.appContext.app._context.config.globalProperties.$df = editor;
    })

    return {
      exportEditor, listNodes, drag, drop, allowDrop, JSONData, importEditor, exportEditorTopo, topoData, toggleEditorMode
    }

  }
}

</script>