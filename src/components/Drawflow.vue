<template>
  <el-container>
    <el-header class="header">
        <h3>QemuWeb</h3>
        <div class="dropdown">
          <button @click="toggleDropDown" class="dropbtn">
            <span class="burger-slice"></span>
            <span class="burger-slice"></span>
            <span class="burger-slice"></span>
          </button>
          <div id="dropdownmenu" class="dropdown-content">
            <a href="#" @click="exportEditor">Export</a>
            <a href="#" @click="displayImport">Import</a>
            <a href="#" @click="displaySettings">Settings</a>
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
          <!--<div class="terminal-container" data-port="43373"></div>-->
      </el-aside>
      <el-main>
          <div id="drawflow" @drop="drop($event)" @dragover="allowDrop($event)"></div>
      </el-main>
    </el-container>
  </el-container>
  <el-dialog v-model="dialogExport" title="Export" width="50%">
    <span>Data:</span>
    <pre><code>{{dialogData}}</code></pre>
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="dialogExport = false"> Cancel </el-button>
        <el-button type="primary" @click="dialogExport = false"> Confirm </el-button>
      </span>
    </template>
  </el-dialog>
  <el-dialog v-model="dialogSettings" title="Settings" width="50%">
    <div class="modal-section">
      <span>Display interfaces name : </span>
      <input id="interfaces-name-check" type="checkbox" checked @change="changeDisplayInterfacesName">
    </div>
    <div class="modal-section">
      <span>Display ports name : </span>
      <input id="ports-name-check" type="checkbox" checked @change="changeDisplayPortsName">
    </div>
  </el-dialog>
  <el-dialog v-model="dialogAbout" title="About" width="50%">
  </el-dialog>
  <div id="settings" style="width:0px;width:0px" data-display-ports-name="true" data-display-interfaces-name="true"></div>
</template>


<script>
import drawflow from 'drawflow';
import styleDrawflow from 'drawflow/dist/drawflow.min.css';
import style from '../assets/style.css';
import styleJquery from '../jquery-ui/jquery-ui.min.css';
import jquery from '../jquery-ui/external/jquery/jquery.js';
import jquery_ui from '../jquery-ui/external/jquery/jquery.js';
import { onMounted, shallowRef, h, getCurrentInstance, render, readonly, ref } from 'vue';
import Host from './nodes/HostComp.vue';
import Switch from './nodes/SwitchComp.vue';
import { TerminalUI } from "../TerminalUI"; 
import io from "socket.io-client";


export default {
  name: 'DrawFlow',
  data() {
    return {
      serverAddress: "127.0.0.1",
      dialogSettings: false,
      dialogAbout: false
    }
  },
  methods: {
    connectToSocket(serverAddr) {
      return new Promise(res => {
        const socket = io(serverAddr);
        res(socket);
      });
    },
    startTerminal(container, socket) {
      const terminal = new TerminalUI(socket);
      terminal.attachTo(container);
      console.log("startTerminal");
      terminal.startListening();
    },
    start() {
      var containers = document.getElementsByClassName("terminal-container");

      if (containers == undefined || containers.length < 1) {
        console.log("Pas de container pour le terminal trouvé");
        return;
      }
      for (let container of containers) {
        console.log("connect on " + this.serverAddress + ":" + container.getAttribute("data-port"))
        this.connectToSocket(this.serverAddress + ":" + container.getAttribute("data-port")).then(socket => {
          this.startTerminal(container, socket);
        });
      }
    },
    toggleDropDown() {
      document.getElementById("dropdownmenu").classList.toggle("show");
    },
    displaySettings() {
      this.dialogSettings = true;
    },
    displayAbout() {
      this.dialogAbout = true;
    },
    changeDisplayInterfacesName() {
      var checked = document.getElementById("interfaces-name-check").checked;
      var display = checked ? "block" : "none";
      document.getElementById("settings").setAttribute("data-display-interfaces-name", checked);
      var interfaces = document.querySelectorAll(".drawflow-node.Host .outputs .output");
      for (const el of interfaces) {
        el.style.setProperty('--vardisplay', display);
      }
    },
    changeDisplayPortsName() {
      var checked = document.getElementById("ports-name-check").checked;
      var display = checked ? "block" : "none";
      document.getElementById("settings").setAttribute("data-display-ports-name", checked);
      var ports = document.querySelectorAll(".drawflow-node.Switch .inputs .input");
      for (const el of ports) {
        el.style.setProperty('--vardisplay', display);
      }
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

    this.start();
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
        input: 1,
        output: 0,
        img: require('@/assets/switch.png'),
        img_class: 'switch'
      }
    ])
    
    var editor;// = shallowRef({})
    const dialogExport = ref(false);
    const dialogData = ref({});
    const Vue = { version: 3, h, render };
    const internalInstance = getCurrentInstance();
    
    function exportEditor() {
      dialogData.value = editor.export();
      dialogExport.value = true;
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
        editor.on("connectionCreated", function(info) {
          const inputNodeInfo = editor.getNodeFromId(info.input_id);
          const outputNodeInfo = editor.getNodeFromId(info.output_id);
          if((inputNodeInfo.class == "Host" && outputNodeInfo.class == "Host")) {
            const last = outputNodeInfo.outputs[info.output_class].connections.length - 1;
            const removeConnectionInfo = outputNodeInfo.outputs[info.output_class].connections[last];
            editor.removeSingleConnection(info.output_id, removeConnectionInfo.node, info.output_class, removeConnectionInfo.output);
          }
        });

        // Make lines straight
        editor.curvature = 0
        editor.reroute_curvature_start_end = 0
        editor.reroute_curvature = 0
        editor.createCurvature = function(start_pos_x, start_pos_y, end_pos_x, end_pos_y) {
            var center_y = (end_pos_y - start_pos_y) / 2 + start_pos_y;
            return (
                ' M ' +
                start_pos_x +
                ' ' +
                start_pos_y +
                ' L ' +
                start_pos_x +
                ' ' +
                center_y +
                ' L ' +
                end_pos_x +
                ' ' +
                center_y +
                ' L ' +
                end_pos_x +
                ' ' +
                end_pos_y
              )
        }
        editor.start();
        
        editor.registerNode('Host', Host, {}, {});
        editor.registerNode('Switch', Switch, {}, {});

        //editor.import({"drawflow":{"Home":{"data":{"5":{"id":5,"name":"Switch","data":{"script":"(req,res) => {\n console.log(req);\n}"},"class":"Switch","html":"Switch","typenode":"vue","inputs":{"input_1":{"connections":[{"node":"6","input_1":"output_1"}]}},"outputs":{"output_1":{"connections":[]},"output_1":{"connections":[]}},"pos_x":1000,"pos_y":117},"6":{"id":6,"name":"Host","data":{"url":"localhost/add", "method": "post"},"class":"Host","html":"Host","typenode":"vue","inputs":{},"outputs":{"output_1":{"connections":[{"node":"5","output":"input_1"}]}},"pos_x":137,"pos_y":89}}}}})
        internalInstance.appContext.app._context.config.globalProperties.$df = editor;
    })

    return {
      exportEditor, listNodes, drag, drop, allowDrop, dialogExport, dialogData
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