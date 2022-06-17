<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';

export default {
  props: {
    show: Boolean,
    switchId: Number,
    name: String,
    portsCount: Number
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
      }
    },
    addPort() {
      this.editor.addNodeInput(this.switchId);
      this.localPortsCount++;
    }
  },
  updated() {
    /// Triggered when modal pop up
    if (this.show) {
      this.loadPorts();
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

.modal-section {
  margin-top: 30px;
  color: black;
}

.modal-mask {
  position: fixed;
  z-index: 9998;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: table;
  transition: opacity 0.3s ease;
}

.modal-wrapper {
  display: table-cell;
  vertical-align: middle;
}

.modal-container {
  width: 400px;
  margin: 0px auto;
  padding: 20px 30px;
  background-color: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.33);
  transition: all 0.3s ease;
}

.modal-header h2 {
  margin-top: 0;
  color: #42b983;
}

.modal-body {
  margin: 20px 0;
}

.modal-default-button {
  float: right;
}

.modal-footer {
  padding-bottom: 15px;
}

/*
 * The following styles are auto-applied to elements with
 * transition="modal" when their visibility is toggled
 * by Vue.js.
 *
 * You can easily play with the modal transition by editing
 * these styles.
 */

.modal-enter-from {
  opacity: 0;
}

.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  -webkit-transform: scale(1.1);
  transform: scale(1.1);
}
</style>