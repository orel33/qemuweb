<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';

export default {
  props: {
    show: Boolean,
    switchId: Number,
    name: String,
    portsCount: Number,
    portsSide: Object,
    refreshPortsDisplay: Function
  },
  computed: {
    editor: {
      get() {
        return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
      }
    },
    localName: {
      get() {
        return this.name;
      },
      set(value) {
        this.$emit('updateHostName', value);
      }
    },
    localPortsCount: {
      get() {
        return this.portsCount;
      },
      set(value) {
        this.$emit('updatePortsCount', value);
      }
    }
  },
  methods: {
    hostsCount() {
      return this.editor.getNodesFromName('Host').length;
    },
    loadPorts() {
      // Load the connections ports/hosts in selects
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.switchId);
      var portsSelects = neighboorsDiv.querySelectorAll(".ports");
      for (let i = 0; i < this.portsCount; i++) {
        if (this.editor.getNodeFromId(this.switchId).inputs['input_'+(i+1)].connections.length > 0) {
          var host = this.editor.getNodesFromName('Host').indexOf(Number(this.editor.getNodeFromId(this.switchId).inputs['input_'+(i+1)].connections[0].node));
          var selectedInterface = this.editor.getNodeFromId(this.switchId).inputs['input_'+(i+1)].connections[0].input.split('_')[1];
          portsSelects[i].value = (host+1) + ':' + selectedInterface;
        }
      }
    },
    portsChanged(index) {
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.switchId);
      var hosts = this.editor.getNodesFromName('Host');
      var selectValue = neighboorsDiv.querySelectorAll(".ports")[index-1].value;
      var hostValue = selectValue.split(':')[0];
      var interfaceValue = selectValue.split(':')[1];
      for (let connection of this.editor.getNodeFromId(this.switchId).inputs['input_'+index].connections) {
        this.editor.removeSingleConnection(connection.node, this.switchId, connection.input, 'input_'+index)
      }
      this.editor.addConnection(hosts[hostValue-1], this.switchId, 'output_' + interfaceValue, 'input_' + index);
    },
    removePort() {
      if (this.portsCount > 1) {
        this.editor.removeNodeInput(this.switchId, 'input_' + this.portsCount);
        this.localPortsCount--;
        this.portsSide.delete(this.portsCount);
      }
    },
    addPort() {
      this.editor.addNodeInput(this.switchId);
      this.localPortsCount++;
      this.portsSide.set(this.portsCount+1, 'left');
      this.refreshPortsDisplay();
    },
    sidesChanged() {
      this.refreshPortsSide();
      this.editor.updateConnectionNodes("node-" + this.switchId);
    },
    refreshPortsSide() {
      for (let i = 1; i <= this.portsSide.size; i++) {
        var side = document.querySelectorAll(".sides")[i-1].value;
        var node = document.querySelector(".drawflow-node.Switch.selected");
        var input = node.querySelector(".inputs .input:nth-child(" + i + ")");
        switch (side) {
          case 'left':
            input.style.left = "-21px";
            input.style.top = "0px";
            input.style.setProperty('--varleft', 'auto');
            input.style.setProperty('--vartop', 'auto');
            break;
          case 'right':
            input.style.left = "75px";
            input.style.top = "0px";
            input.style.setProperty('--varleft', '23px');
            input.style.setProperty('--vartop', 'auto');
            break;
          /*case 'up':
            input.style.left = "26px";
            input.style.top = "-63px";
            input.style.setProperty('--varleft', '-6px');
            input.style.setProperty('--vartop', '-24px');
            break;
          case 'down':
            input.style.left = "26px";
            input.style.top = "74px";
            input.style.setProperty('--varleft', '-6px');
            input.style.setProperty('--vartop', '17px');
            break;*/
        }
        this.portsSide.set(i, side);
      }
    },
    loadPortsSides() {
      for (let i = 0; i < document.querySelectorAll(".sides").length; i++) {
        document.querySelectorAll(".sides")[i].value = this.portsSide.get(i+1);
      }
      this.refreshPortsSide();
    }
  },
  updated() {
    /// Triggered when modal pop up
    if (this.show) {
      this.loadPorts();
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

          <div :id="'modal-body-div-' + switchId" class="modal-body">
            <div class="modal-section">
              <span class="modal-span title"> Name : </span>
              <input class="host-name-in-modal" type="text" v-model="localName">
            </div>
            <div class="ports-div modal-section">
              <span class="modal-span title"> Port management : </span>

              <div class="ports-buttons">
                <button class="ports-btn-minus" @click="removePort"> - </button>
                <button class="ports-btn-plus" @click="addPort"> + </button>
              </div>

              <div class="ports-for" v-for="index in portsCount" :key="index">
                <span class="modal-span"> #{{index-1}} -- </span>
                <select class="ports" @change="portsChanged(index)">
                  <option label=" -- " value="-1"></option>
                  <optgroup v-for="indexS in hostsCount()" :key="indexS" :label="editor.getNodeFromId(editor.getNodesFromName('Host')[indexS-1]).data.name">
                    <option v-for="indexI in editor.getNodeFromId(editor.getNodesFromName('Host')[indexS-1]).data.interfacesCount" :key="indexI" 
                            :label="editor.getNodeFromId(editor.getNodesFromName('Host')[indexS-1]).data.name + '/eth' + (indexI-1)" :value="indexS + ':' + indexI">
                    </option>
                  </optgroup>
                </select>
                

                <span class="modal-span at"> at </span>
                <select class="sides" @change="sidesChanged()">
                  <option label="left" value="left" selected></option>
                  <option label="right" value="right" ></option>
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
.ports-for {
  margin-top: 10px;
}
</style>