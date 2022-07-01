<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';
import { Settings } from '@/Settings';

export default {
  data() {
    return {
      settings: new Settings()
    }
  },
  props: {
    show: Boolean,
    hostId: Number,
    name: String,
    distributions: Array,
    system: String,
    neighboors: Map,
    interfacesCount: Number,
    interfacesSide: Object,
    refreshInterfacesDisplay: Function
  },
  computed: {
    localSystem: {
      get() {
        return this.system;
      },
      set(value) {
        this.$emit('updateSystem', value)
      }
    },
    localName: {
      get() {
        return this.name;
      },
      set(value) {
        this.$emit('updateHostName', value)
      }
    },
    localNeighboors: {
      get() {
        return this.neighboors;
      },
      set(value) {
        this.$emit('updateNeighboors', value)
      }
    },
    localInterfacesCount: {
      get() {
        return this.interfacesCount;
      },
      set(value) {
        this.$emit('updateInterfaces', value)
      }
    },
    editor: {
      get() {
        return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
      }
    },
    isReducedMode: {
      get() {
        return this.settings.getOptionBool('reduced-mode');
      }
    }
  },
  methods: {
    loadInterfaces() {
      // Load the connections interfaces/switches in selects
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switchesSelects = neighboorsDiv.querySelectorAll(".switches");
      for (let i = 0; i < this.interfacesCount; i++) {
        if (this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections.length > 0) {
          var switchId = this.editor.getNodesFromName('Switch').indexOf(Number(this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections[0].node));
          var port = this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections[0].output.split('_')[1];
          switchesSelects[i].value = (switchId+1) + ':' + port;
        }
      }
    },
    switchesChanged(index) {
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switches = this.editor.getNodesFromName('Switch');
      var selectValue = neighboorsDiv.querySelectorAll(".switches")[index-1].value;
      var switchValue = selectValue.split(':')[0];
      var portValue = selectValue.split(':')[1];
      for (let connection of this.editor.getNodeFromId(this.hostId).outputs['output_'+index].connections) {
        this.editor.removeSingleConnection(this.hostId, connection.node, 'output_'+index, connection.output)
      }
      this.editor.addConnection(this.hostId, switches[switchValue-1], 'output_' + index, 'input_' + portValue);
    },
    removeInterface() {
      if (this.interfacesCount > 1) {
        this.editor.removeNodeOutput(this.hostId, 'output_' + this.interfacesCount);
        this.localInterfacesCount--;
        this.interfacesSide.delete(this.interfacesCount);
      }
    },
    addInterface() {
      this.editor.addNodeOutput(this.hostId);
      this.localInterfacesCount++;
      this.refreshInterfacesDisplay();
      this.interfacesSide.set(this.interfacesCount+1, 'right');
    },
    switchesCount() {
      return this.editor.getNodesFromName('Switch').length;
    },
    sidesChanged() {
      this.refreshInterfacesSide();
      this.editor.updateConnectionNodes("node-" + this.hostId);
    },
    refreshInterfacesSide() {
      if (this.isReducedMode) {
        return;
      }
      for (let i = 1; i <= this.interfacesSide.size; i++) {
        var side = document.querySelectorAll(".sides")[i-1].value;
        var node = document.querySelector(".drawflow-node.Host.selected");
        var output = node.querySelector(".outputs .output:nth-child(" + i + ")");
        switch (side) {
          case 'left':
            output.style.left = "-89px";
            output.style.right = "";
            output.style.top = "0px";
            output.style.setProperty('--varleft', '-43px');
            output.style.setProperty('--vartop', 'auto');
            break;
          case 'right':
            output.style.left = "8px";
            output.style.right = "";
            output.style.top = "0px";
            output.style.setProperty('--varleft', 'auto');
            output.style.setProperty('--vartop', 'auto');
            break;
        }
        this.interfacesSide.set(i, side);
        this.editor.updateConnectionNodes('node-' + this.id);
      }
    },
    loadPortsSides() {
      for (let i = 0; i < document.querySelectorAll(".sides").length; i++) {
        document.querySelectorAll(".sides")[i].value = this.interfacesSide.get(i+1);
      }
      this.refreshInterfacesSide();
    }
  },
  updated() {
    /// Triggered when modal pop up
    if (this.show) {
      this.loadInterfaces();
      this.loadPortsSides();
    }
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-mask">
      <div class="modal-wrapper">
        <div class="modal-container">
          <div class="modal-header">
            <slot name="header">default header</slot>
          </div>

          <div :id="'modal-body-div-' + hostId" class="modal-body">
            <div class="modal-section">
              <span class="modal-span title"> System : </span>
              <select v-model="localSystem">
                <option v-for="item in distributions" :key="item.value" :label="item.label" :value="item.value"></option>
              </select>
            </div>
            <div class="modal-section">
              <span class="modal-span title"> Name : </span>
              <input class="host-name-in-modal" type="text" v-model="localName">
            </div>
            <div class="interfaces-div modal-section">
              <span class="modal-span title"> Network interface management : </span>

              <div class="interfaces-buttons">
                <button class="interfaces-btn-minus" @click="removeInterface"> - </button>
                <button class="interfaces-btn-plus" @click="addInterface"> + </button>
              </div>

              <div class="interfaces-for" v-for="index in interfacesCount" :key="index">
                <span class="modal-span"> eth{{index-1}} -- </span>
                <select class="switches" @change="switchesChanged(index)">
                  <option label=" -- " value="-1"></option>
                  <optgroup v-for="indexS in switchesCount()" :key="indexS" :label="editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.name">
                    <option v-for="indexP in editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.portsCount" :key="indexP" 
                            :label="editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.name + '/ #' + (indexP-1)" :value="indexS + ':' + indexP">
                    </option>
                  </optgroup>
                </select>

                <span class="modal-span at"> at </span>
                <select class="sides" @change="sidesChanged()">
                  <option label="left" value="left"></option>
                  <option label="right" value="right" selected></option>
                </select>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <slot name="footer">
              <button class="modal-default-button" @click="$emit('close')"> OK </button>
            </slot>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
.interfaces-for {
  margin-top: 10px;
}
</style>